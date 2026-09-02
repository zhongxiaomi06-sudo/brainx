#!/usr/bin/env node
/** brainx-lark-gateway — 飞书事件网关启动与群管理 CLI。
 *
 * 子命令：
 *   start [--mock]                      启动 WS 长连接网关（--mock 不真实连飞书，仅校验凭证与可启动性）
 *   list-chats                          用 im:chat:readonly 列出机器人所在群（取 chat_id）
 *   register <chat_id> [--bot-mode MENTION_ONLY|ALL] [--notes "..."]  登记群到 chat_contexts
 *
 * 凭证从 .env 读取（LARK_APP_ID / LARK_APP_SECRET / LARK_ENCRYPT_KEY / LARK_VERIFICATION_TOKEN）；
 * 旧键 BRAINX_FEISHU_* 不改动，供其他模块使用，网关一律用 LARK_*。
 * 用法：node --env-file=.env bin/brainx-lark-gateway.mjs start   （或 npm run 无，直接 node）
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { startGateway, stopGateway } from '../src/gateway/ws-client.js';
import { registerChatContext, listChatContexts } from '../src/gateway/chat-contexts.js';

const FEISHU_BASE = 'https://open.feishu.cn';

function credentialsFromEnv() {
  return {
    appId: process.env.LARK_APP_ID,
    appSecret: process.env.LARK_APP_SECRET,
    encryptKey: process.env.LARK_ENCRYPT_KEY,
    verificationToken: process.env.LARK_VERIFICATION_TOKEN,
  };
}

function requireCreds(c) {
  const missing = ['appId', 'appSecret', 'encryptKey', 'verificationToken'].filter((f) => !c[f]);
  if (missing.length) {
    console.error(`❌ .env 缺少 LARK_* 凭证：${missing.map((m) => `LARK_${m.replace(/([A-Z])/g, '_$1').toUpperCase()}`).join(', ')}`);
    console.error('   按 specs/002-step1-lark-gateway/quickstart.md 清单配置；旧键 BRAINX_FEISHU_* 不改，新增 LARK_*。');
    process.exit(2);
  }
}

async function getTenantAccessToken(c) {
  const r = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
  });
  return (await r.json())?.tenant_access_token;
}

const cmd = process.argv[2] ?? 'start';
const db = openDb();

if (cmd === 'start') {
  const c = credentialsFromEnv();
  if (process.argv.includes('--mock')) {
    startGateway({ db, credentials: c, mode: 'mock' }).then((r) => {
      console.log(JSON.stringify(r));
      stopGateway();
    });
  } else {
    requireCreds(c);
    let stopped = false;
    const shutdown = async (sig) => {
      if (stopped) return;
      stopped = true;
      console.error(`\n收到 ${sig}，停止网关…`);
      stopGateway();
      process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    startGateway({ db, credentials: c, onEvent: (evt, r) => console.log(JSON.stringify(r)) }).then((r) => {
      if (!r.ok) {
        console.error('❌ 网关启动失败：', JSON.stringify(r));
        process.exit(1);
      }
      console.error(`✅ 网关已启动（mode=${r.mode}, botOpenId=${r.botOpenId}）。@机器人发消息即落 workflow_event_log。Ctrl+C 退出。`);
      setInterval(() => {}, 60000); // 保活，WSClient 连接自带 ref'd handle，此为双保险
    });
  }
} else if (cmd === 'list-chats') {
  const c = credentialsFromEnv();
  requireCreds(c);
  const token = await getTenantAccessToken(c);
  if (!token) { console.error('❌ 获取 tenant_access_token 失败'); process.exit(1); }
  const r = await fetch(`${FEISHU_BASE}/open-apis/im/v1/chats?page_size=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.json();
  if (body.code !== 0) { console.error('❌ 列群失败：', JSON.stringify(body)); process.exit(1); }
  const items = body.data?.items ?? [];
  console.log(`机器人所在群 ${items.length} 个：`);
  for (const it of items) console.log(`${it.chat_id}\t${it.name ?? '(无名)'}\t${it.chat_mode ?? ''}`);
} else if (cmd === 'register') {
  const chatId = process.argv[3];
  if (!chatId) { console.error('用法：register <chat_id> [--bot-mode MENTION_ONLY|ALL] [--notes "..."]'); process.exit(2); }
  const bmIdx = process.argv.indexOf('--bot-mode');
  const botMode = bmIdx > -1 ? process.argv[bmIdx + 1] : 'MENTION_ONLY';
  const notesIdx = process.argv.indexOf('--notes');
  const notes = notesIdx > -1 ? process.argv[notesIdx + 1] : null;
  registerChatContext(db, { chat_id: chatId, bot_mode: botMode, notes });
  console.log(`✅ 已登记 ${chatId}（bot_mode=${botMode}）`);
  console.log('当前全部登记：', JSON.stringify(listChatContexts(db), null, 2));
} else {
  console.error(`未知子命令：${cmd}\n可用：start [--mock] | list-chats | register <chat_id> [--bot-mode ...] [--notes ...]`);
  process.exit(2);
}
