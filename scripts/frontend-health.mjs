#!/usr/bin/env node
/** frontend-health.mjs — 前端白屏 / 资产一致性健康检查。
 *
 * 背景：2026-08-25 白屏事故——vinext start 长驻进程持有旧构建清单，
 * 重新 build 后 SSR HTML 引用的水合入口 chunk 404，页面白屏。
 * 本脚本就是那次事故的探测特征：
 *   1. 首页 200 且 SSR 正文非空（body 文本量阈值）；
 *   2. HTML 引用的全部资产（modulepreload / css / 入口 import / 字体）逐个回源必须 200；
 *   3. URL 中不得出现绝对文件系统路径（跨机器拷贝构建产物的特征，如 /opt/brainx/...）。
 *
 * 用法：node scripts/frontend-health.mjs [--url http://127.0.0.1:4321] [--json]
 * 退出码：0 健康，1 异常（CI / launchd 看门狗可直接消费）。
 */

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = opt('--url', process.env.BRAINX_FRONTEND_URL || 'http://127.0.0.1:4321').replace(/\/+$/, '');
const AS_JSON = args.includes('--json');
const MIN_TEXT = Number(opt('--min-text', 500));

const failures = [];
const note = (ok, msg) => { if (!ok) failures.push(msg); return ok; };

async function fetchText(path) {
  const res = await fetch(BASE + path, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  return { status: res.status, text: await res.text() };
}

// SSR 正文近似文本量：去标签去空白
function visibleTextLen(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '').length;
}

// 收集 HTML 里引用的全部同源资产 URL
function collectAssets(html) {
  const urls = new Set();
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]+?)"/g)) urls.add(m[1]);
  for (const m of html.matchAll(/import\("(\/[^"]+?)"\)/g)) urls.add(m[1]); // 水合入口
  return [...urls].filter((u) => /\.(js|mjs|css|woff2?|ttf|svg|png)(\?|$)/.test(u));
}

// 跨机器拷贝构建的特征：URL 里烤进了构建机的绝对路径
function looksLikeFsPath(u) {
  return /^\/(opt|Users|home|srv|var|root)\//.test(u) || u.includes('.vinext/fonts');
}

const report = { url: BASE, checked_at: new Date().toISOString(), page: null, assets: [], failures };

try {
  const page = await fetchText('/');
  report.page = { status: page.status, bytes: page.text.length, text_len: visibleTextLen(page.text) };
  note(page.status === 200, `首页状态码 ${page.status}（期望 200）`);
  note(report.page.text_len >= MIN_TEXT,
    `SSR 正文文本量 ${report.page.text_len} < ${MIN_TEXT}——疑似白屏/空壳渲染`);

  const assets = collectAssets(page.text);
  report.assets_total = assets.length;

  const results = await Promise.all(assets.map(async (a) => {
    if (looksLikeFsPath(a)) return { url: a, status: 0, fs_path: true };
    try {
      const res = await fetch(BASE + a, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      if (res.status === 405 || res.status === 501) {
        const g = await fetch(BASE + a, { signal: AbortSignal.timeout(10_000) });
        return { url: a, status: g.status };
      }
      return { url: a, status: res.status };
    } catch (e) {
      return { url: a, status: -1, error: String(e.message || e) };
    }
  }));
  report.assets = results;

  for (const r of results) {
    if (r.fs_path) note(false, `资产 URL 含构建机绝对路径（跨机器拷贝的脏构建）：${r.url}`);
    else note(r.status === 200, `资产 ${r.url} 状态 ${r.status}——HTML↔产物哈希不一致，水合将失败（白屏特征）`);
  }
} catch (e) {
  note(false, `首页不可达：${e.message || e}`);
}

report.ok = failures.length === 0;

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[frontend-health] ${BASE}  page=${report.page?.status ?? 'ERR'} text=${report.page?.text_len ?? 0} assets=${report.assets_total ?? 0}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  console.log(report.ok ? '[frontend-health] OK' : '[frontend-health] FAIL');
}
process.exit(report.ok ? 0 : 1);
