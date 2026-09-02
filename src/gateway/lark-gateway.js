/** lark-gateway.js — Step 1 飞书事件网关纯逻辑层（processLarkEvent）。
 *
 * 权威契约: specs/002-step1-lark-gateway/spec.md FR-002/FR-007；
 * 输入为 SDK 解密后的标准消息事件（{message_id,chat_id,open_id,mentions,
 * message_type,create_time,body}），输出 {ack, action, reason?}。
 * 逻辑仅本地 SQLite 读写，<3s 无网络 IO；appendEvent 幂等由 Step 0 兜底。
 */
import { appendEvent } from '../hub/event-log.js';
import { getChatContext } from './chat-contexts.js';
import { mapAcceptedEnvelope, mapDeniedEnvelope } from './envelope-mapper.js';
import { persistLarkMessage } from './lark-messages.js';

export const BOT_OPEN_ID = 'ou_bot'; // 测试/默认约定值；真实运行由 ws-client 启动时调 bot/v3/info 拿机器人真实 open_id 注入

/**
 * 处理一条已解密的飞书消息事件。
 * @param {object} db
 * @param {object} evt 解密后标准消息事件
 * @param {string} [botOpenId] 机器人真实 open_id（运行时由 ws-client 注入；缺省回落 BOT_OPEN_ID 测试约定）
 * @returns {{ack:boolean, action:'queued'|'denied'|'duplicate', reason?:string}}
 */
export function processLarkEvent(db, evt, botOpenId = BOT_OPEN_ID) {
  if (!evt || !evt.message_id) return { ack: false, reason: 'malformed_event' };
  if (!evt.chat_id) return deny(db, evt, 'no_chat_scope');

  const ctx = getChatContext(db, evt.chat_id);
  if (!ctx) return deny(db, evt, 'unregistered_chat');
  if (!ctx.enabled) return deny(db, evt, 'chat_disabled');
  if (ctx.bot_mode === 'MENTION_ONLY' && !(evt.mentions ?? []).includes(botOpenId)) {
    return deny(db, evt, 'not_mentioned');
  }

  persistLarkMessage(db, evt); // 正文落 lark_messages（evidence_refs 引用目标；幂等）
  const r = appendEvent(db, mapAcceptedEnvelope(evt, ctx));
  if (!r.ok) return { ack: false, reason: r.reason }; // schema_invalid / payload_too_large
  return r.deduplicated ? { ack: true, action: 'duplicate' } : { ack: true, action: 'queued' };
}

function deny(db, evt, reason) {
  appendEvent(db, mapDeniedEnvelope(evt, reason));
  return { ack: true, action: 'denied', reason };
}
