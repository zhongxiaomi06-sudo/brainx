#!/usr/bin/env node
/**
 * run.mjs — 飞书群卡片渲染回归门禁（阻断式）。
 *
 * 背景：群卡片由 src/*.js 的纯函数产出 JSON、由飞书渲染。仓库原有 24 项门禁
 * 只断言「有没有这个按钮」，没有任何一项会渲染卡片并检查排版，所以「卡片不好看」
 * 永远不会让门禁变红。本脚本补上这一环。
 *
 * 三件事：
 *   1) 用真实构建函数产出卡片，归一化可变字段（时间戳/签名/运行号）后渲染成 DOM；
 *   2) 落 PNG 截图，与 fixtures/card-render/baseline 下的基线比对（按平台分档）；
 *   3) 断言可判定的排版硬规则：按钮文字截断、卡片横向溢出、渲染器未覆盖元素；
 *   4) 断言文字排版纪律（typography.mjs）：块行数、连续标签行、动作块按钮数、
 *      标题位置、冒号全角。规则定义见 docs/standards/CARD_TYPOGRAPHY.md。
 *
 * 用法：
 *   node scripts/quality-gate/card-render/run.mjs              # 校验（CI/门禁用）
 *   node scripts/quality-gate/card-render/run.mjs --update      # 重建基线（需人眼确认后提交）
 *   node scripts/quality-gate/card-render/run.mjs --only candidate-share
 *
 * 环境变量：
 *   BRAINX_CARD_DIFF_RATIO  允许的像素差异比例，默认 0.004（0.4%）
 *   BRAINX_CARD_PLATFORM    覆盖平台分档名（默认 process.platform）
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const CSS = readFileSync(join(HERE, 'theme.css'), 'utf8');
const SHOT_DIR = join(ROOT, '.quality-gate/reports/card-render');
const BASELINE_DIR = join(ROOT, 'fixtures/card-render/baseline');

const argv = new Set(process.argv.slice(2));
const UPDATE = argv.has('--update');
const ONLY = (() => {
  const index = process.argv.indexOf('--only');
  return index >= 0 ? process.argv[index + 1] : null;
})();
const DIFF_LIMIT = Number(process.env.BRAINX_CARD_DIFF_RATIO || 0.004);
const PLATFORM = process.env.BRAINX_CARD_PLATFORM || process.platform;

// 用系统 Chrome 而不是 Playwright 自带浏览器：仓库原有的浏览器链路检查
// （frontend/btex-frontend/tests/e2e-browser-check.mjs）就是 channel="chrome"，
// 本机与 GitHub ubuntu runner 都自带 Chrome；而 Playwright 的 bundled 浏览器
// 需要额外的 `npx playwright install`，CI 里没有装，门禁会直接死在启动浏览器这一步。
const BROWSER_CHANNEL = process.env.BRAINX_CARD_BROWSER_CHANNEL || 'chrome';

/** 解析「已人工确认截图基线的平台」列表，默认只认 darwin（基线在 macOS 上人工确认过）。 */
export function parsePlatformList(value) {
  return new Set(String(value || 'darwin').split(',').map((name) => name.trim()).filter(Boolean));
}
// 只有这些平台上「缺基线」才阻断。其它平台（如 CI 的 linux）没有人工确认过的基线，
// 像素比对无从谈起 —— 此时跳过像素比对并在报告里显著提示；而截断、横向溢出、
// 文字排版这些断言与字体栅格化无关，在所有平台照常生效，CI 依然拦得住排版回归。
const CURATED_PLATFORMS = parsePlatformList(process.env.BRAINX_CARD_BASELINE_PLATFORMS);

// 卡片里带日期、签名、运行号等每次运行都变的字段；不归一化就无法做基线比对。
// 顺序有讲究：先吃掉带年份的完整时间戳，再吃只带月日的相对时间戳（卡片标题用的是
// now().slice(5, 16) 形式，如「09-12 19:05」——漏掉它会让标题随时钟逐分钟变化，
// 基线每次 --update 都被改写，门禁还可能因分钟数字位数变化而偶发阻断）。
const VOLATILE_RULES = [
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, '«TS»'],
  [/\b\d{2}-\d{2}[T ]\d{2}:\d{2}\b/g, '«TS»'],
  [/\d{4}-\d{2}-\d{2}/g, '«DATE»'],
  [/\b[0-9a-f]{8,}\b/gi, '«HEX»'],
];

export function canonicalize(value) {
  if (typeof value === 'string') {
    return VOLATILE_RULES.reduce((text, [pattern, token]) => text.replace(pattern, token), value);
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

async function readMetrics(page) {
  return page.evaluate(() => {
    const card = document.querySelector('.feishu-card');
    // scrollWidth / clientWidth 都是整数取整。多个中文按钮挤在一行时，文字宽度往往只
    // 超出不到 1px，取整后两者相等 → 漏判（实测「一键加入人才库」被省略号吃掉却报 PASS）。
    // 改用 Range 量文字的真实排版宽度，与按钮内容宽度精确比较。
    // 注意 clientWidth 已排除 border、但包含 padding，所以只减 padding，不能再减 border
    // （减两次会让每个按钮都误判成截断）。
    const textOverflows = (btn) => {
      const style = getComputedStyle(btn);
      const content = btn.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const range = document.createRange();
      range.selectNodeContents(btn);
      const width = range.getBoundingClientRect().width;
      range.detach?.();
      return width > content + 0.5;
    };
    const actionRows = [...document.querySelectorAll('.el-actions')].map((row) => {
      const buttons = [...row.querySelectorAll('.btn')];
      const tops = new Set(buttons.map((btn) => Math.round(btn.getBoundingClientRect().top)));
      return {
        buttons: buttons.length,
        renderedRows: tops.size,
        truncated: buttons.filter(textOverflows).map((btn) => (btn.textContent || '').trim()),
      };
    });
    const columns = [...document.querySelectorAll('.col')]
      .map((col) => Math.round(col.getBoundingClientRect().height));
    return {
      cardHeight: Math.round(card.getBoundingClientRect().height),
      overflowX: card.scrollWidth > card.clientWidth + 1,
      actionRows,
      maxColumnHeight: columns.length ? Math.max(...columns) : 0,
      noteCount: document.querySelectorAll('.el-note').length,
    };
  });
}

async function pixelDiffRatio(page, baselinePath, shotPath) {
  const toBase64 = (path) => readFileSync(path).toString('base64');
  return page.evaluate(async ([left, right]) => {
    const decode = async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
      return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    };
    const [a, b] = await Promise.all([decode(left), decode(right)]);
    if (a.width !== b.width || a.height !== b.height) {
      return { ratio: 1, reason: `尺寸不同 ${a.width}x${a.height} vs ${b.width}x${b.height}` };
    }
    const canvas = new OffscreenCanvas(a.width, a.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(a, 0, 0);
    const dataA = ctx.getImageData(0, 0, a.width, a.height).data;
    ctx.clearRect(0, 0, a.width, a.height);
    ctx.drawImage(b, 0, 0);
    const dataB = ctx.getImageData(0, 0, a.width, a.height).data;
    let changed = 0;
    for (let i = 0; i < dataA.length; i += 4) {
      if (Math.abs(dataA[i] - dataB[i]) > 12 || Math.abs(dataA[i + 1] - dataB[i + 1]) > 12
        || Math.abs(dataA[i + 2] - dataB[i + 2]) > 12 || Math.abs(dataA[i + 3] - dataB[i + 3]) > 12) {
        changed += 1;
      }
    }
    return { ratio: changed / (dataA.length / 4), reason: `${changed} 个像素不同` };
  }, [toBase64(baselinePath), toBase64(shotPath)]);
}

function blockingReasons(metrics, diff) {
  const reasons = [];
  if (metrics.overflowX) reasons.push({ rule: 'overflow-x', detail: '卡片出现横向溢出' });
  for (const [index, row] of metrics.actionRows.entries()) {
    for (const label of row.truncated) {
      reasons.push({ rule: 'button-truncated', detail: `第 ${index + 1} 组按钮文字被截断：${label}` });
    }
  }
  if (diff && diff.ratio > DIFF_LIMIT) {
    reasons.push({ rule: 'pixel-diff', detail: `截图与基线差异 ${(diff.ratio * 100).toFixed(2)}% `
      + `> ${(DIFF_LIMIT * 100).toFixed(2)}%（${diff.reason}）` });
  }
  return reasons;
}

/** 存量缺陷登记：与 .quality-gate/baseline.json 同一治理口径——只能减少、不得新增、
 *  到期即失效。未登记的同类缺陷一律阻断；登记且未到期的只报告、不阻断。 */
function loadKnownDefects() {
  const file = join(ROOT, 'fixtures/card-render/known-defects.json');
  if (!existsSync(file)) return [];
  const today = new Date().toISOString().slice(0, 10);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return (Array.isArray(parsed) ? parsed : parsed.defects || []).map((entry) => ({
    ...entry, expired: String(entry.expiresOn || '') < today,
  }));
}

function splitByRegistration(reasons, knownDefects, cardId) {
  const failures = [];
  const registered = [];
  for (const reason of reasons) {
    const hit = knownDefects.find((entry) => entry.id === cardId && entry.rule === reason.rule && !entry.expired);
    if (hit) {
      registered.push({ ...reason, expiresOn: hit.expiresOn, reason: hit.reason });
    } else {
      const expired = knownDefects.find((entry) => entry.id === cardId && entry.rule === reason.rule);
      failures.push({
        rule: reason.rule,
        detail: expired ? `${reason.detail}（存量缺陷登记已于 ${expired.expiresOn} 过期，必须修复或续期）` : reason.detail,
      });
    }
  }
  return { failures, registered };
}

async function main() {
  process.env.BRAINX_FEEDBACK_SECRET = process.env.BRAINX_FEEDBACK_SECRET || 'card-render-gate-fixture';
  const { renderCardDocument } = await import('./renderer.mjs');
  const { buildScenarios } = await import('./scenarios.mjs');
  const { checkTypography } = await import('./typography.mjs');

  const scenarios = buildScenarios().filter((item) => !ONLY || item.id === ONLY);
  if (!scenarios.length) throw new Error(`没有匹配的卡片样本：${ONLY || '(空)'}`);
  const knownDefects = loadKnownDefects();
  if (argv.has('--list-defects')) {
    for (const entry of knownDefects) {
      process.stdout.write(`${entry.id}\t${entry.rule}\t${entry.expiresOn}\t${entry.reason}\n`);
    }
    return;
  }

  mkdirSync(SHOT_DIR, { recursive: true });
  if (UPDATE) mkdirSync(BASELINE_DIR, { recursive: true });

  const browser = await chromium.launch({ channel: BROWSER_CHANNEL });
  const context = await browser.newContext({ viewport: { width: 452, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' });

  const results = [];
  for (const scenario of scenarios) {
    const entry = { id: scenario.id, title: scenario.title, failures: [], registered: [] };
    const reasons = [];
    try {
      const card = canonicalize(scenario.card);
      // 排版纪律是纯 JSON 判定，不依赖渲染；渲染失败时也要照常报出来。
      entry.typography = checkTypography(card);
      reasons.push(...entry.typography);
      const html = renderCardDocument(card, { css: CSS, title: scenario.title, cardId: scenario.id });
      await page.setContent(html, { waitUntil: 'load' });
      const shot = join(SHOT_DIR, `${scenario.id}.png`);
      await page.locator('.feishu-card').screenshot({ path: shot });
      entry.metrics = await readMetrics(page);

      const baseline = join(BASELINE_DIR, `${scenario.id}.${PLATFORM}.png`);
      if (UPDATE) {
        writeFileSync(baseline, readFileSync(shot));
        entry.baseline = 'updated';
      } else if (!existsSync(baseline)) {
        if (CURATED_PLATFORMS.has(PLATFORM)) {
          entry.baseline = 'missing';
          reasons.push({ rule: 'baseline-missing',
            detail: `缺少基线 fixtures/card-render/baseline/${scenario.id}.${PLATFORM}.png，`
              + '确认截图无误后跑 --update 生成' });
        } else {
          entry.baseline = 'skipped-uncurated';
        }
      } else {
        entry.baseline = 'compared';
        entry.diff = await pixelDiffRatio(page, baseline, shot);
      }
      reasons.push(...blockingReasons(entry.metrics, entry.diff));
    } catch (error) {
      reasons.push({ rule: 'render-error', detail: `渲染失败：${error.message}` });
    }
    const split = splitByRegistration(reasons, knownDefects, scenario.id);
    entry.failures = split.failures;
    entry.registered = split.registered;
    results.push(entry);
  }

  await browser.close();

  const summary = {
    generatedAt: new Date().toISOString(), platform: PLATFORM, update: UPDATE,
    browserChannel: BROWSER_CHANNEL, curatedPlatforms: [...CURATED_PLATFORMS],
    diffLimit: DIFF_LIMIT, shots: SHOT_DIR, passed: results.filter((r) => !r.failures.length).length,
    registeredCount: results.reduce((sum, entry) => sum + entry.registered.length, 0),
    baselineSkipped: results.filter((entry) => entry.baseline === 'skipped-uncurated').length,
    total: results.length, results,
  };
  writeFileSync(join(SHOT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(join(SHOT_DIR, 'summary.md'), renderSummaryMarkdown(summary));
  writeFileSync(join(SHOT_DIR, 'gallery.html'), renderGallery(summary));

  const failed = results.filter((entry) => entry.failures.length);
  process.stdout.write(`卡片渲染回归：${summary.passed}/${summary.total} 通过（平台 ${PLATFORM}`
    + `，浏览器 ${BROWSER_CHANNEL}）`
    + `${summary.registeredCount ? `，另 ${summary.registeredCount} 项存量缺陷已登记` : ''}\n`);
  if (summary.baselineSkipped) {
    process.stdout.write(`  提示：平台 ${PLATFORM} 没有人工确认的截图基线，`
      + `已跳过 ${summary.baselineSkipped} 张卡片的像素比对（截断 / 横向溢出 / 文字排版断言仍全部生效）；`
      + '需要像素基线请在本平台跑 --update 并人眼确认后提交。\n');
  }
  for (const entry of results) {
    const mark = entry.failures.length ? 'FAIL' : entry.registered.length ? 'WARN' : 'PASS';
    const shape = entry.metrics
      ? `高 ${entry.metrics.cardHeight}px · ${entry.metrics.actionRows.length} 组按钮`
      : '—';
    process.stdout.write(`  [${mark}] ${entry.id} — ${shape}\n`);
    for (const reason of entry.failures) process.stdout.write(`         ↳ 阻断：${reason.detail}\n`);
    for (const reason of entry.registered) {
      process.stdout.write(`         ↳ 已登记（{${reason.expiresOn}} 到期）：${reason.detail}\n`);
    }
  }
  if (UPDATE) process.stdout.write(`基线已更新：${BASELINE_DIR}\n`);
  if (failed.length) process.exitCode = 1;
}

/** 把全部卡片截图摊在一页里，供人眼一次性复核排版；门禁只判定几何事实，
 *  「好不好看」最终仍要人看这一页。 */
function renderGallery(summary) {
  const escape = (text) => String(text ?? '').replace(/[&<>"]/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
  const cards = summary.results.map((entry) => {
    const status = entry.failures.length ? '阻断' : entry.registered.length ? '存量登记' : '通过';
    const tone = entry.failures.length ? '#a32d2d' : entry.registered.length ? '#854f0b' : '#0f6e56';
    const notes = [...entry.failures, ...entry.registered]
      .map((item) => `<li>${escape(item.detail)}</li>`).join('');
    const metrics = entry.metrics
      ? `高 ${entry.metrics.cardHeight}px · ${entry.metrics.actionRows.length} 组按钮 · 最大列高 ${entry.metrics.maxColumnHeight}px`
      : '未渲染';
    return `<figure><figcaption><b>${escape(entry.id)}</b>`
      + `<span style="color:${tone}">${status}</span></figcaption>`
      + `<img src="./${escape(entry.id)}.png" alt="${escape(entry.title)}">`
      + `<p class="meta">${escape(entry.title)}<br>${metrics}</p>`
      + (notes ? `<ul>${notes}</ul>` : '')
      + '</figure>';
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`
    + '<title>飞书群卡片渲染复核页</title><style>'
    + 'body{margin:0;padding:24px;background:#f7f8f9;color:#1f2329;font:14px/1.6 "PingFang SC",sans-serif}'
    + 'h1{font-size:18px;margin:0 0 4px}.sub{color:#5f5e5a;margin:0 0 20px}'
    + '.grid{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start}'
    + 'figure{margin:0;width:452px;background:#fff;border:1px solid #e3e5e8;border-radius:12px;padding:12px}'
    + 'figcaption{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}'
    + 'img{width:100%;display:block;border:1px solid #e3e5e8;border-radius:8px}'
    + '.meta{color:#8f959e;font-size:12px;margin:8px 0 0}'
    + 'ul{margin:6px 0 0;padding-left:18px;color:#a32d2d;font-size:12px}'
    + '</style></head><body>'
    + '<h1>飞书群卡片渲染复核页</h1>'
    + `<p class="sub">平台 ${escape(summary.platform)} · 浏览器 ${escape(summary.browserChannel)} · `
    + `${summary.passed}/${summary.total} 通过 · `
    + `${summary.registeredCount || 0} 项存量登记 · `
    + `${summary.baselineSkipped ? `像素比对已跳过 ${summary.baselineSkipped} 张 · ` : ''}`
    + `生成于 ${escape(summary.generatedAt)}</p>`
    + `<div class="grid">${cards}</div></body></html>`;
}

function renderSummaryMarkdown(summary) {
  const lines = [
    '# 飞书群卡片渲染回归报告', '',
    `- 生成时间：${summary.generatedAt}`,
    `- 平台分档：${summary.platform}（浏览器 ${summary.browserChannel}）`,
    ...(summary.baselineSkipped
      ? [`- 像素比对：本平台无人工确认基线，已跳过 ${summary.baselineSkipped} 张卡片的像素比对`
        + '（截断 / 横向溢出 / 文字排版断言仍生效）']
      : []),
    `- 结果：${summary.passed}/${summary.total} 通过`,
    `- 截图目录：\`${summary.shots}\``,
    `- 模式：${summary.update ? '重建基线' : '校验基线'}`, '',
    '| 卡片 | 结果 | 卡片高 | 按钮组 | 每行按钮数 | 最大列高 | 差异 | 排版纪律 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const entry of summary.results) {
    const m = entry.metrics;
    const rows = m ? m.actionRows.map((row) => row.buttons).join('/') || '—' : '—';
    const diff = entry.diff ? `${(entry.diff.ratio * 100).toFixed(2)}%` : (entry.baseline || '—');
    const verdict = entry.failures.length ? '不通过' : entry.registered.length ? '通过（有存量登记）' : '通过';
    const typo = entry.typography?.length ? `${entry.typography.length} 项违规` : 'OK';
    lines.push(`| ${entry.id} | ${verdict} | `
      + `${m ? `${m.cardHeight}px` : '—'} | ${m ? m.actionRows.length : '—'} | ${rows} | `
      + `${m ? `${m.maxColumnHeight}px` : '—'} | ${diff} | ${typo} |`);
  }
  const failures = summary.results.filter((entry) => entry.failures.length);
  if (failures.length) {
    lines.push('', '## 阻断原因', '');
    for (const entry of failures) {
      lines.push(`- **${entry.id}**`);
      for (const reason of entry.failures) lines.push(`  - [${reason.rule}] ${reason.detail}`);
    }
  }
  const registered = summary.results.filter((entry) => entry.registered.length);
  if (registered.length) {
    lines.push('', '## 存量缺陷登记（只报告、不阻断，到期必须清理）', '');
    for (const entry of registered) {
      for (const reason of entry.registered) {
        lines.push(`- **${entry.id}** · [${reason.rule}] ${reason.detail} — ${reason.reason}（${reason.expiresOn} 到期）`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

// 被测试 import 时不得顺手跑一遍门禁，只有直接执行才进 main。
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`卡片渲染门禁自身失败：${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
