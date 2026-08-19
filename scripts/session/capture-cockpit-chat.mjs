/**
 * capture-cockpit-chat.mjs — 用「你自己的飞书登录态」抓驾驶舱群对话，直接入库到 brainx 的
 * job_messages（复用 bridge.js 的 ingestMessages：幂等去重 + 职位归因 + 可见性 + 游标）。
 *
 * 为什么走浏览器抓取而非官方 API：飞书官方 App 权限申请不下来。这里抓的是「你自己账号本就
 * 能看到的、本人同意公开的对话」，用你自己一套登录凭证——合法边界内的登录态复用。
 *
 * 数据来源策略（更稳）：不扒 DOM，而是监听飞书网页端调用的消息接口响应（JSON），
 *   把它规整成 ingestMessages 认识的消息形状（{message_id, content, msg_type, sender, create_time}）。
 *
 * 前置：
 *   1) 先跑 login-capture.mjs 拿到加密登录态 .state.enc
 *   2) .env 里有 SESSION_ENCRYPTION_KEY
 *
 * 用法：
 *   node scripts/session/capture-cockpit-chat.mjs "<驾驶舱群/会话页面URL>" [chat_id] [consultant_id]
 *   例：node scripts/session/capture-cockpit-chat.mjs "https://.../messenger/oc_xxx" oc_xxx felix
 *
 * 环境变量：
 *   MSG_API_HINT   消息接口 URL 片段，默认 "/messages"（按实际抓包结果调整）
 *   HEADLESS       true 无头（默认）/ false 有头调试
 *   SCROLL_ROUNDS  向上滚动加载历史的轮数（默认 6）
 *   DRY_RUN        true 只打印不入库（默认 false）
 */
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decrypt } from './crypto.mjs';
import { openDb } from '../../src/db.js';
import { ingestMessages } from '../../src/bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));
try {
  for (const line of readFileSync(join(HERE, '../../.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2];
  }
} catch { /* ignore */ }

const pageUrl = process.argv[2];
const chatId = process.argv[3] || '';
const consultantId = process.argv[4] || 'felix';
if (!pageUrl) { console.error('用法：node scripts/session/capture-cockpit-chat.mjs "<页面URL>" [chat_id] [consultant_id]'); process.exit(1); }

const STATE_FILE = process.env.SESSION_FILE || join(HERE, '.state.enc');
const MSG_API_HINT = process.env.MSG_API_HINT || '/messages';
const HEADLESS = process.env.HEADLESS !== 'false';
const SCROLL_ROUNDS = Number(process.env.SCROLL_ROUNDS || 6);
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!existsSync(STATE_FILE)) { console.error(`找不到登录态 ${STATE_FILE}，先跑 login-capture.mjs`); process.exit(1); }
const storageState = JSON.parse(decrypt(readFileSync(STATE_FILE, 'utf8')));

/** 把飞书网页消息接口的一条原始记录，规整成 ingestMessages 认识的形状。
 *  不同版本字段名可能不同——这里做宽松兼容，抓不到就留空，绝不塞假值。 */
function normalize(raw, fallbackChatId) {
  const id = raw.message_id || raw.id || raw.msg_id;
  if (!id) return null;
  const contentRaw = raw.content ?? raw.body?.content ?? raw.text ?? '';
  const content = typeof contentRaw === 'string' ? contentRaw : JSON.stringify(contentRaw);
  const ct = raw.create_time || raw.createTime || raw.timestamp || raw.time;
  return {
    message_id: String(id),
    chat_id: raw.chat_id || raw.chatId || fallbackChatId,
    msg_type: raw.msg_type || raw.type || 'text',
    content,
    create_time: toLocal(ct),
    deleted: !!(raw.deleted || raw.is_deleted),
    sender: { name: raw.sender?.name || raw.sender_name || raw.from_name || raw.sender?.id || '' },
  };
}
const pad = (n) => String(n).padStart(2, '0');
function toLocal(v) {
  if (!v) return '';
  let ms = Number(v);
  if (!Number.isFinite(ms)) { const p = Date.parse(v); if (!Number.isNaN(p)) ms = p; else return ''; }
  if (ms < 1e12) ms *= 1000; // 秒→毫秒
  const d = new Date(ms + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

chromium.use(stealth());
const browser = await chromium.launch({ headless: HEADLESS, args: ['--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({ storageState, locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

const collected = new Map(); // message_id → normalized
page.on('response', async (res) => {
  if (!res.url().includes(MSG_API_HINT)) return;
  if (!(res.headers()['content-type'] || '').includes('json')) return;
  let data; try { data = await res.json(); } catch { return; }
  // 宽松地在响应里找消息数组
  const arr = data?.data?.items || data?.data?.messages || data?.items || data?.messages || [];
  for (const raw of Array.isArray(arr) ? arr : []) {
    const n = normalize(raw, chatId);
    if (n && !n.deleted) collected.set(n.message_id, n);
  }
});

console.log(`[cockpit] 打开会话页：${pageUrl}`);
// SPA 页面（飞书 messenger）长轮询不断，networkidle 永不满足会 60s 超时 → 用 domcontentloaded + 等 SPA 初始化
await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);

// 向上滚动触发历史消息接口，逐轮加载
for (let i = 0; i < SCROLL_ROUNDS; i++) {
  await page.mouse.wheel(0, -1200).catch(() => {});
  await page.waitForTimeout(1200);
  process.stdout.write(`\r[cockpit] 加载历史 ${i + 1}/${SCROLL_ROUNDS}，已抓 ${collected.size} 条`);
}
console.log('');

const messages = [...collected.values()];
if (!messages.length) {
  console.warn(`[cockpit] ⚠️ 没抓到消息。可能：①MSG_API_HINT="${MSG_API_HINT}" 不匹配实际接口 ②登录态过期。`);
  console.warn('  建议：HEADLESS=false 打开，用 DevTools 看消息接口真实 URL 片段，再用 MSG_API_HINT 指定。');
  await browser.close(); process.exit(0);
}

if (DRY_RUN) {
  console.log(`[cockpit] DRY_RUN：抓到 ${messages.length} 条，示例：`);
  console.log(JSON.stringify(messages.slice(0, 3), null, 2));
} else {
  const db = openDb(process.env.BRAINX_DB || join(HERE, '../../data/brainx.db'));
  const cid = chatId || messages[0].chat_id;
  const { inserted, matched } = ingestMessages(db, cid, messages, consultantId);
  console.log(`[cockpit] 入库完成：抓 ${messages.length} 条 → 新增 ${inserted} 条（去重后）、归因职位 ${matched} 条。`);
  console.log('[cockpit] 已写入 job_messages（幂等）+ 更新游标 + 可见性，驾驶舱可用。');
}
await browser.close();
