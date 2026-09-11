/**
 * capture-liepin-talent.mjs — 猎聘人才搜索 GUI 抓取 POC（用你自己的账号）。
 *
 * 背景（2026-09-11）：SuperMai 的真实形态是「GUI 模拟点击在猎聘等网站搜索」，
 *   不是 API。实测无头浏览器（即便带 stealth）访问猎聘会返回 200 但跳转到
 *   about:blank（强反爬），因此本脚本默认**有头模式**跑，由顾问本人操作。
 *
 * 做什么：
 *   1) 复用 login-capture.mjs 抓下的加密登录态，打开猎聘起始页；
 *   2) 你手动导航到人才搜索页、填条件、点搜索，出结果后回终端回车；
 *   3) 脚本抓三样东西：页面 URL、完整 HTML、全页截图；
 *   4) **顺带录下页面调用的所有 JSON 接口**——GUI 抓取的终局通常是发现底层
 *      搜索接口后直连（比解析 DOM 稳得多），所以这一步是 POC 的核心产出；
 *   5) 用一组候选选择器试探人才卡片，把命中数量和文本样本导出，供精化选择器。
 *
 * 合法边界：仅用你自己的账号、访问你本就有权看到的内容；不绕过风控、不抓他人凭证。
 * 产物含个人信息，落 scripts/session/out/（已在 .gitignore 中），不得外传或入库。
 *
 * 用法：
 *   node scripts/session/capture-liepin-talent.mjs
 *   HEADFUL=false 可切无头（猎聘大概率被拦，仅用于对照）
 *
 * 环境变量：
 *   SESSION_FILE       加密登录态（默认 scripts/session/.state-liepin.enc）
 *   LIEPIN_START_URL   起始页（默认 https://www.liepin.com/）
 *   OUT_DIR            输出目录（默认 scripts/session/out）
 *   API_HINT           只录 URL 含该片段的接口（默认 /api/，留空=全部 JSON）
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { decrypt } from './crypto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(HERE, '../../.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch { /* 无 .env 时靠外部注入 */ }

const STATE_FILE = process.env.SESSION_FILE || join(HERE, '.state-liepin.enc');
const START_URL = process.env.LIEPIN_START_URL || 'https://www.liepin.com/';
const OUT_DIR = process.env.OUT_DIR || join(HERE, 'out');
const API_HINT = process.env.API_HINT ?? '/api/';
const HEADFUL = process.env.HEADFUL !== 'false';

if (!existsSync(STATE_FILE)) {
  console.error(`找不到登录态 ${STATE_FILE}`);
  console.error('先跑：LOGIN_URL=https://www.liepin.com/ SESSION_FILE=scripts/session/.state-liepin.enc node scripts/session/login-capture.mjs');
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const CARD_SELECTORS = [
  '[class*="resume-card"]', '[class*="resumeCard"]', '[class*="resumeItem"]',
  '[class*="talent-item"]', '[class*="talentItem"]', '[class*="candidate"]',
  '[class*="card-item"]', '[class*="list-item"]', '[class*="search-item"]',
  'li[class*="item"]', '[class*="card"]',
];

function waitEnter(msg) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(msg, () => { rl.close(); res(); }));
}

const storageState = JSON.parse(decrypt(readFileSync(STATE_FILE, 'utf8')));
chromium.use(stealth());
const browser = await chromium.launch({
  headless: !HEADFUL,
  args: ['--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({ storageState, locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const apiHits = [];
page.on('response', async (res) => {
  const url = res.url();
  if (!url.includes('liepin.com')) return;
  const ct = res.headers()['content-type'] || '';
  if (!ct.includes('json')) return;
  if (API_HINT && !url.includes(API_HINT)) return;
  try {
    const body = await res.json();
    apiHits.push({ url, status: res.status(), body });
  } catch { /* 非 JSON 或已失效连接，跳过 */ }
});

console.log(`[liepin] 打开 ${START_URL}（${HEADFUL ? '有头' : '无头'}）`);
await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
  console.warn('[liepin] 打开失败（无头多半被反爬拦）：' + e.message.slice(0, 120));
});

let round = 0;
for (;;) {
  const ans = (await waitEnter(`\n>>> 在浏览器里完成搜索、结果出来后回车抓取（第 ${++round} 次）；输入 q 回车结束：\n`)).trim();
  if (ans.toLowerCase() === 'q') break;

  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-r${round}`;
  const snapshot = { at: new Date().toISOString(), url: page.url(), title: await page.title().catch(() => ''), selectors: [] };

  for (const sel of CARD_SELECTORS) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    const samples = [];
    for (let i = 0; i < Math.min(count, 8); i += 1) {
      const text = await loc.nth(i).innerText().catch(() => '');
      if (text) samples.push(text.replace(/\s+/g, ' ').slice(0, 300));
    }
    snapshot.selectors.push({ selector: sel, count, samples });
  }

  const html = await page.content().catch(() => '');
  writeFileSync(join(OUT_DIR, `liepin-${stamp}.html`), html);
  await page.screenshot({ path: join(OUT_DIR, `liepin-${stamp}.png`), fullPage: true }).catch(() => {});
  writeFileSync(join(OUT_DIR, `liepin-${stamp}.json`), JSON.stringify(snapshot, null, 2));

  const top = snapshot.selectors.slice(0, 3).map((s) => `${s.selector}(${s.count})`).join(' ');
  console.log(`[liepin] 已抓 ${stamp}｜URL=${snapshot.url}`);
  console.log(`[liepin] 命中选择器：${top || '无'}`);
  const sample = snapshot.selectors[0]?.samples?.[0];
  if (sample) console.log(`[liepin] 首条样本：${sample.slice(0, 160)}`);
}

writeFileSync(join(OUT_DIR, `liepin-api-${Date.now()}.json`), JSON.stringify(apiHits, null, 2));
console.log(`[liepin] 录到 ${apiHits.length} 条 JSON 接口（${API_HINT || '全部'}）`);
for (const hit of apiHits.slice(0, 12)) console.log('  - ' + hit.url.replace(/^https:\/\/[^/]+/, ''));

await browser.close();
console.log(`[liepin] 完成，输出在 ${OUT_DIR}`);
