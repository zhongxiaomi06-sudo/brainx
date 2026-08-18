/**
 * login-capture.mjs — 抓取「你自己账号」的登录态并加密存盘。
 *
 * 用途（合法）：你用自己的账号扫码登录飞书，脚本把登录成功后的 storageState
 *   （cookie + localStorage）加密保存，后续脚本免登录复用，减少重复扫码。
 *   —— 全程是你自己的凭证；不绕过风控、不抓别人的号。
 *
 * 用法：
 *   1) npm i -D playwright playwright-extra puppeteer-extra-plugin-stealth
 *      npx playwright install chromium
 *   2) 在 .env 里放 SESSION_ENCRYPTION_KEY（见 crypto.mjs 注释）
 *   3) node scripts/session/login-capture.mjs
 *      浏览器会打开飞书登录页 → 你手动扫码 → 登录进主界面后，回终端按 Enter
 *
 * 环境变量：
 *   LOGIN_URL      要登录的起始页（默认飞书）
 *   READY_URL_HINT 登录成功后 URL 里应包含的关键片段（用于自动判断已登录，可选）
 *   SESSION_FILE   加密登录态输出路径（默认 scripts/session/.state.enc）
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { encrypt } from './crypto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// 载入 .env（不依赖 dotenv）
try {
  for (const line of readFileSync(join(HERE, '../../.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch { /* 无 .env 时靠外部注入 */ }

const LOGIN_URL = process.env.LOGIN_URL || 'https://www.feishu.cn/';
const READY_HINT = process.env.READY_URL_HINT || '';
const OUT = process.env.SESSION_FILE || join(HERE, '.state.enc');

chromium.use(stealth());

function waitEnter(msg) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(msg, () => { rl.close(); res(); }));
}

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  locale: 'zh-CN',
  viewport: { width: 1280, height: 860 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
});
const page = await ctx.newPage();

console.log(`[capture] 打开登录页：${LOGIN_URL}`);
await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

if (READY_HINT) {
  console.log(`[capture] 等待登录成功（URL 含「${READY_HINT}」）…最多 3 分钟`);
  try { await page.waitForURL((u) => u.href.includes(READY_HINT), { timeout: 180000 }); console.log('[capture] 检测到已登录 ✅'); }
  catch { console.log('[capture] 未自动检测到，改为手动确认。'); }
}
await waitEnter('\n>>> 请在浏览器里完成扫码登录，进入主界面后回车继续…\n');

const state = await ctx.storageState();
const cookieCount = state.cookies.length;
writeFileSync(OUT, encrypt(JSON.stringify(state)));
console.log(`[capture] 已加密保存登录态 → ${OUT}（${cookieCount} 个 cookie）`);
console.log('[capture] 完成。后续用 session-reuse.mjs 免登录复用。');

await browser.close();
