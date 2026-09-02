/** ws-client.js — Step 1 飞书 SDK WS 长连接客户端骨架。
 *
 * 权威契约: specs/002-step1-lark-gateway/spec.md FR-006/US5；
 * 凭证缺失优雅降级（返回 credentials_missing 不抛）；凭证就绪时用
 * @larksuiteoapi/node-sdk 的 WSClient + EventDispatcher 订阅 im.message.receive_v1，
 * 解密后调 processLarkEvent。mode='mock' 供测试与本地预览（不真实连 WS）。
 * 真实联调凭证清单见 quickstart.md。
 *
 * 机器人真实 open_id：live 模式启动时调 GET /open-apis/bot/v3/info 获取并注入
 * processLarkEvent 的 botOpenId 参数（修复 lark-gateway.js 的 BOT_OPEN_ID 占位符缺陷：
 * 真实飞书事件机器人 open_id 是 ou_xxxx，永远不会等于占位常量，会导致所有 @机器人
 * 消息误判 not_mentioned）。getBotOpenId 失败显式返回 bot_info_failed，不静默回落占位值。
 */
import { processLarkEvent, BOT_OPEN_ID } from './lark-gateway.js';

let activeClient = null;
let activeBotOpenId = BOT_OPEN_ID; // mock/未启动时回落测试约定值

const REQUIRED_FIELDS = ['appId', 'appSecret', 'encryptKey', 'verificationToken'];

function credentialsMissing(c) {
  return !c || REQUIRED_FIELDS.some((f) => !c[f]);
}

const FEISHU_BASE = 'https://open.feishu.cn';

/** 调 bot/v3/info 拿机器人真实 open_id（live 模式启动时一次网络调用）。 */
export async function getBotOpenId({ appId, appSecret }) {
  const tokRes = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokBody = await tokRes.json();
  const token = tokBody?.tenant_access_token;
  if (!token) return { ok: false, reason: 'bot_info_failed', detail: 'tenant_access_token 缺失', tokCode: tokBody?.code };
  const infoRes = await fetch(`${FEISHU_BASE}/open-apis/bot/v3/info`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const infoBody = await infoRes.json();
  if (infoBody?.code !== 0 || !infoBody?.bot?.open_id) {
    return { ok: false, reason: 'bot_info_failed', detail: `bot/v3/info code=${infoBody?.code} msg=${infoBody?.msg}`, infoCode: infoBody?.code };
  }
  return { ok: true, openId: infoBody.bot.open_id };
}

/**
 * 启动飞书 WS 长连接网关。
 * @param {{db:object, credentials?:object, mode?:'live'|'mock', onEvent?:Function}} opts
 * @returns {Promise<{ok:boolean, mode?:string, reason?:string, botOpenId?:string}>}
 */
export async function startGateway(opts = {}) {
  const { db, credentials, mode = 'live', onEvent } = opts;
  if (credentialsMissing(credentials)) {
    return { ok: false, reason: 'credentials_missing' };
  }
  if (activeClient) {
    return { ok: false, reason: 'already_running' };
  }
  if (mode === 'mock') {
    activeClient = { mode: 'mock', closed: false };
    activeBotOpenId = BOT_OPEN_ID;
    return { ok: true, mode: 'mock', botOpenId: BOT_OPEN_ID };
  }
  // live 模式：先拿机器人真实 open_id 注入 MENTION_ONLY 判定，失败显式报错不静默回落
  const bot = await getBotOpenId(credentials);
  if (!bot.ok) return bot; // {ok:false, reason:'bot_info_failed', detail, ...}
  activeBotOpenId = bot.openId;
  const { WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');
  const dispatcher = new EventDispatcher({
    encryptKey: credentials.encryptKey,
    verificationToken: credentials.verificationToken,
  }).register({
    'im.message.receive_v1': (data) => {
      const evt = decodeLarkMessage(data);
      const r = processLarkEvent(db, evt, activeBotOpenId);
      if (onEvent) onEvent(evt, r);
      return r.ack;
    },
  });
  activeClient = new WSClient({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    eventDispatcher: dispatcher,
  });
  activeClient.start();
  return { ok: true, mode: 'live', botOpenId: activeBotOpenId };
}

/** 停止网关单例。 */
export function stopGateway() {
  if (activeClient && typeof activeClient.close === 'function') {
    activeClient.close();
  }
  activeClient = null;
}

/** 把 SDK 解密后的消息事件归一成 processLarkEvent 的输入结构。 */
function decodeLarkMessage(data) {
  const msg = data?.message;
  if (!msg) return { message_id: null };
  let mentions = [];
  try {
    mentions = JSON.parse(msg.mentions ?? '[]').map((m) => m.id?.open_id).filter(Boolean);
  } catch {
    mentions = [];
  }
  return {
    message_id: msg.message_id ?? null,
    chat_id: msg.chat_id ?? null,
    open_id: msg.author?.open_id ?? null,
    mentions,
    message_type: msg.message_type ?? 'text',
    create_time: msg.create_time ? new Date(Number(msg.create_time) * 1000).toISOString() : undefined,
    body: msg.body ?? {},
  };
}
