/**
 * session-reuse.mjs — 用已加密的登录态「免登录」访问你有权看到的页面并抓取内容。
 *
 * 用途（合法）：复用你自己的 session，打开你登录后本就能看到的页面，
 *   把可见内容 / 目标接口响应抓下来。不做任何风控绕过。
 *
 * 用法：
 *   node scripts/session/session-reuse.mjs "https://要抓的页面URL"
 *
 * 环境变量：
 *   SESSION_FILE   加密登录态路径（默认 scripts/session/.state.enc）
 *   HEADLESS       true=无头（默认）；false=有头，便于调试
 *   OUT_DIR        抓取输出目录（默认 scripts/session/out）
 *   CAPTURE_API    可选：只保存 URL 含该片段的接口 JSON 响应（如 "/api/" 或某私有接口路径）
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decrypt } from './crypto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(HERE, '../../.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2];
  }
} catch { /* ignore */ }

const targetUrl = process.argv[2];
if (!targetUrl) { console.error('用法：node scripts/session/session-reuse.mjs "<页面URL>"'); process.exit(1); }

const STATE_FILE = process.env.SESSION_FILE || join(HERE, '.state.enc');
const HEADLESS = process.env.HEADLESS !== 'false';
const OUT_DIR = process.env.OUT_DIR || join(HERE, 'out');
const CAPTURE_API = process.env.CAPTURE_API || '';

if (!existsSync(STATE_FILE)) { console.error(`找不到登录态 ${STATE_FILE}，先跑 login-capture.mjs`); process.exit(1); }
mkdirSync(OUT_DIR, { recursive: true });

const storageState = JSON.parse(decrypt(readFileSync(STATE_FILE, 'utf8')));

chromium.use(stealth());
const browser = await chromium.launch({ headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ storageState, locale: 'zh-CN', viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();

// 可选：抓取目标接口的 JSON 响应
const apiHits = [];
if (CAPTURE_API) {
  page.on('response', async (res) => {
    if (!res.url().includes(CAPTURE_API)) return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try { apiHits.push({ url: res.url(), status: res.status(), body: await res.json() }); } catch { /* 非 JSON 跳过 */ }
  });
}

console.log(`[reuse] 免登录打开：${targetUrl}`);
await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const html = await page.content();
writeFileSync(join(OUT_DIR, `page-${stamp}.html`), html);
await page.screenshot({ path: join(OUT_DIR, `page-${stamp}.png`), fullPage: true });
const title = await page.title();
console.log(`[reuse] 已保存页面 HTML + 截图（标题：${title}）`);

if (CAPTURE_API) {
  writeFileSync(join(OUT_DIR, `api-${stamp}.json`), JSON.stringify(apiHits, null, 2));
  console.log(`[reuse] 抓到 ${apiHits.length} 条含「${CAPTURE_API}」的接口响应 → api-${stamp}.json`);
}

// 判断登录态是否仍有效（简单启发：出现登录/扫码字样多半已失效）
const loginWall = await page.locator('text=/扫码登录|请登录|登录后可/').count().catch(() => 0);
if (loginWall > 0) console.warn('[reuse] ⚠️ 页面疑似要求重新登录，登录态可能已过期，请重跑 login-capture.mjs');

await browser.close();
console.log(`[reuse] 完成，输出在 ${OUT_DIR}`);
