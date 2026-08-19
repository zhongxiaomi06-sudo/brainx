/** diag-frontend.mjs — 前端白屏诊断：无头浏览器打开工作台，捕获 console/pageerror，逐步点击职位详情复现白屏。 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());
const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('[console] ' + m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message + '\n' + String(e.stack || '').slice(0, 600)));
page.on('requestfailed', (r) => { const u = r.url(); if (u.includes('127.0.0.1:3100')) errors.push('[reqfail] ' + u.slice(0, 120) + ' · ' + r.failure()?.errorText); });

console.log('[diag] 打开工作台…');
await page.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(7000);

const bodyText = (await page.textContent('body').catch(() => '')) || '';
console.log('[diag] 页面文本长度:', bodyText.length, '· 标题片段:', bodyText.slice(0, 80).replace(/\s+/g, ' '));
await page.screenshot({ path: '/tmp/diag-1-home.png', fullPage: false });

// 逐步点开第一个职位（多候选选择器）
const selectors = ['.job-card', '[class*="job"] [class*="row"]', 'table tbody tr', '[class*="opportunit"]', 'li[role="button"]'];
let clicked = null;
for (const sel of selectors) {
  const el = page.locator(sel).first();
  if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
    try { await el.click({ timeout: 3000 }); clicked = sel; break; } catch { /* try next */ }
  }
}
console.log('[diag] 点击选择器:', clicked || '（未找到可点元素，尝试全页点击第一个列表项）');
if (!clicked) {
  const any = page.locator('main li, main tr, main [class*="item"]').first();
  if (await any.count() > 0) { await any.click({ timeout: 3000 }).catch(() => {}); clicked = 'fallback'; }
}
await page.waitForTimeout(4000);
const afterText = (await page.textContent('body').catch(() => '')) || '';
console.log('[diag] 点击后页面文本长度:', afterText.length);
await page.screenshot({ path: '/tmp/diag-2-detail.png', fullPage: false });

// 尝试切到承接 tab（engagement——含 OpenmaiPanel）
const tabSel = page.locator('text=/承接|engagement/i').first();
if (await tabSel.count() > 0 && await tabSel.isVisible().catch(() => false)) {
  await tabSel.click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('[diag] 已尝试切换承接 tab');
  await page.screenshot({ path: '/tmp/diag-3-engagement.png', fullPage: false });
}

console.log('\n===== 捕获到的错误 =====');
console.log(errors.length ? errors.join('\n---\n') : '（无 console/pageerror 错误）');

await browser.close();
