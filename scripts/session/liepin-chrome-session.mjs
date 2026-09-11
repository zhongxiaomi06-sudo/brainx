/**
 * liepin-chrome-session.mjs — 驱动「你本机真实 Chrome」登录猎聘并落盘登录态。
 *
 * 为什么不用 Playwright 自带的 chromium（2026-09-11 实测）：
 *   ① 无头 / stealth / 有头 chromium 访问猎聘都被导航到 about:blank；
 *   ② 真实 Chrome + CDP 也一样；
 *   ③ 诊断到根因：猎聘 WAF 对本机出口 IP 做风控，302 到
 *      `safe.liepin.com/intercept/ip/captcha/dispatch`，导致它微前端远程模块
 *      `feim.liepin.com/lp-manifest.json` 跨域加载失败 → 前端应用崩溃 → about:blank。
 *   所以必须由**真人过一次 IP 验证码 + 登录**，之后 cookie（acw_* / 登录态）放行，
 *   同一 profile 里脚本即可全自动接管。
 *
 * 做什么：
 *   1) 启动真实 Chrome（独立 profile + CDP），打开猎聘；
 *   2) 轮询等待你在窗口里过验证码 / 登录 —— 检测到页面恢复正常即视为通过；
 *   3) 把登录态 AES 加密落盘（默认 scripts/session/.state-liepin.enc）——
 *      **只保留猎聘域名**（见 pruneStorageState），避免把本机其它网站的会话一起写进去；
 *   4) 顺带列出页面上疑似「人才搜索」的入口链接，便于下一轮直接直达。
 *
 * 合法边界：仅用你自己的账号、访问你本就有权看到的内容；不绕过风控（验证码由你本人完成）。
 *
 * 用法：node scripts/session/liepin-chrome-session.mjs
 *
 * 环境变量：
 *   CHROME_PATH   Chrome 可执行文件（默认 macOS 安装路径）
 *   CDP_PORT      调试端口（默认 9224）
 *   PROFILE_DIR   Chrome 用户目录（默认 ~/.brainx-chrome-liepin）
 *   SESSION_FILE  登录态输出（默认 scripts/session/.state-liepin.enc）
 *   COOKIE_DOMAIN_ALLOW  落盘时只保留该域名后缀的 cookie（默认 liepin.com）
 *   WAIT_MINUTES  等待人工处理的最长分钟数（默认 10）
 *   START_URL     起始页（默认猎聘首页）
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { encrypt } from './crypto.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2];
  }
} catch { /* 无 .env 时靠外部注入 */ }

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT = Number(process.env.CDP_PORT || 9224);
const PROFILE_DIR = process.env.PROFILE_DIR || join(homedir(), '.brainx-chrome-liepin');
const OUT = process.env.SESSION_FILE || join(HERE, '.state-liepin.enc');
const WAIT_MS = Number(process.env.WAIT_MINUTES || 10) * 60_000;
const START_URL = process.env.START_URL || 'https://www.liepin.com/';

const require2 = createRequire(join(ROOT, 'package.json'));
const { chromium } = require2('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ALLOW = process.env.COOKIE_DOMAIN_ALLOW || 'liepin.com';

/**
 * 裁剪 storageState：只留 ALLOW 域名下的 cookie（外加通用 WAF cookie）。
 * 为什么必须裁：这个 Chrome profile 是共用的，`ctx.storageState()` 会把**整个
 * profile 的全部 cookie** 一起落盘。2026-09-11 实测一次抓取落盘 311 个 cookie /
 * 67 个域名，其中只有 18 个是猎聘，其余 293 个是本人 Google / 飞书 / GitHub /
 * ChatGPT / DeepSeek 等账号的完整会话 cookie——那等于把整套登录态写进一个密文文件。
 */
function pruneStorageState(state, allow = ALLOW) {
  const suffix = String(allow).toLowerCase();
  const keepDomain = (d) => String(d || '').replace(/^\./, '').toLowerCase().endsWith(suffix);
  const keepCookie = (c) => keepDomain(c.domain) || /^acw_|^cdn_sec_tc$/i.test(c.name);
  return {
    cookies: (state?.cookies || []).filter(keepCookie),
    origins: (state?.origins || []).filter((o) => String(o?.origin || '').toLowerCase().includes(suffix)),
  };
}

if (!existsSync(CHROME_PATH)) {
  console.error(`找不到 Chrome：${CHROME_PATH}（用 CHROME_PATH 指定）`);
  process.exit(1);
}
mkdirSync(PROFILE_DIR, { recursive: true });

const cdpReady = async () => {
  try { return (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(3000) })).ok; }
  catch { return false; }
};

if (!(await cdpReady())) {
  // 清掉代理环境变量：本机透明代理会把浏览器流量也带走，直连行为更接近你日常浏览器。
  const env = { ...process.env, NO_PROXY: '*' };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
  const proc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--disable-features=ChromeWhatsNewUI',
  ], { detached: true, stdio: 'ignore', env });
  proc.unref();
  console.log(`[liepin] 已启动真实 Chrome（pid=${proc.pid}，profile=${PROFILE_DIR}）`);
  for (let i = 0; i < 60; i += 1) { if (await cdpReady()) break; await sleep(500); }
}
if (!(await cdpReady())) { console.error('[liepin] CDP 未就绪，退出'); process.exit(1); }

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
const ctx = browser.contexts()[0];
const page = await ctx.newPage();

page.on('framenavigated', (f) => {
  const u = f.url();
  if (f === page.mainFrame() && !u.startsWith('about:')) console.log('  [nav] ' + u.slice(0, 120));
});

console.log(`[liepin] 打开 ${START_URL}`);
await page.goto(START_URL, { waitUntil: 'commit', timeout: 60000 })
  .catch((e) => console.warn('[liepin] 打开异常：' + e.message.slice(0, 120)));

const start = Date.now();
let lastNote = '';
let passed = false;
while (Date.now() - start < WAIT_MS) {
  await sleep(3000);
  const url = page.url();
  const len = await page.evaluate(() => document.documentElement?.outerHTML?.length ?? 0).catch(() => -1);
  const onCaptcha = url.includes('safe.liepin.com');
  if (onCaptcha) {
    if (lastNote !== 'captcha') {
      console.log('\n>>> 需要你操作：浏览器窗口里出现了 IP 验证 / 滑块，请手动完成。');
      lastNote = 'captcha';
    }
    continue;
  }
  if (url.includes('liepin.com') && len > 20_000) {
    passed = true;
    console.log(`\n[liepin] ✅ 风控已放行（url=${url}，html=${len} 字节）`);
    break;
  }
  if (lastNote !== 'waiting') {
    console.log('[liepin] 等待页面恢复中…（url=' + url.slice(0, 70) + '，html=' + len + '）');
    console.log('>>> 如窗口里没有内容或要求验证，请手动点一下页面 / 完成验证。');
    lastNote = 'waiting';
  }
}

if (!passed) {
  console.error('\n[liepin] 等待超时，未检测到风控放行。窗口保持打开，处理完可重跑本脚本（会复用同一 profile）。');
  process.exit(2);
}

await sleep(2000);
const rawState = await ctx.storageState();
const state = pruneStorageState(rawState);
writeFileSync(OUT, encrypt(JSON.stringify(state)));
const dropped = rawState.cookies.length - state.cookies.length;
console.log(`[liepin] 登录态已加密保存 → ${OUT}（${state.cookies.length} 个 cookie）`);
if (dropped > 0) {
  console.log(`[liepin] 已剔除 ${dropped} 个非 ${ALLOW} cookie（该 profile 是共用的，不裁会把本人其它网站会话一并落盘）`);
}

const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')]
  .map((a) => ({ text: (a.textContent || '').trim().slice(0, 20), href: a.href }))
  .filter((x) => x.text && /人才|简历|搜索|寻访|talent|resume|search/i.test(x.text + ' ' + x.href))
  .slice(0, 25)).catch(() => []);
if (links.length) {
  console.log('[liepin] 页面上的疑似找人入口：');
  for (const l of links) console.log(`  - ${l.text} → ${l.href}`);
}
console.log('[liepin] 完成。Chrome 窗口保持打开（勿关），下一轮可直接跑抓取脚本。');
process.exit(0);
