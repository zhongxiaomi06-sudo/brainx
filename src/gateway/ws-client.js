/** ws-client.js — Step 1 飞书 SDK WS 长连接客户端骨架。
 *
 * 权威契约: specs/002-step1-lark-gateway/spec.md FR-006/US5；
 * 凭证缺失优雅降级（返回 credentials_missing 不抛）；凭证就绪时用
 * @larksuiteoapi/node-sdk 的 WSClient + EventDispatcher 订阅 im.message.receive_v1，
 * 解密后调 processLarkEvent。mode='mock' 供测试与本地预览（不真实连 WS）。
 * 真实联调凭证清单见 quickstart.md。
 */
import { processLarkEvent } from './lark-gateway.js';

let activeClient = null;

const REQUIRED_FIELDS = ['appId', 'appSecret', 'encryptKey', 'verificationToken'];

function credentialsMissing(c) {
  return !c || REQUIRED_FIELDS.some((f) => !c[f]);
}

/**
 * 启动飞书 WS 长连接网关。
 * @param {{db:object, credentials?:object, mode?:'live'|'mock', onEvent?:Function}} opts
 * @returns {Promise<{ok:boolean, mode?:string, reason?:string}>}
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
    return { ok: true, mode: 'mock' };
  }
  // live 模式：动态 import SDK，避免凭证缺失时强依赖网络与实例化
  const { WSClient, EventDispatcher } = await import('@larksuiteoapi/node-sdk');
  const dispatcher = new EventDispatcher({
    encryptKey: credentials.encryptKey,
    verificationToken: credentials.verificationToken,
  }).register({
    'im.message.receive_v1': (data) => {
      const evt = decodeLarkMessage(data);
      const r = processLarkEvent(db, evt);
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
  return { ok: true, mode: 'live' };
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
