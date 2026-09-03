/** envelope-mapper.js — Step 1 解密后事件 → 标准信封映射。
 *
 * 权威契约: specs/002-step1-lark-gateway/data-model.md 信封映射契约表；
 * 通过事件 event_type=lark.message_received，DENY 事件 event_type=lark.ignored，
 * DENY idem_key 独立（避免被通过事件吃掉）。payload 不含消息正文 PII。
 */
import { uuid, now } from '../db.js';

const BOT_REF = { table: 'chat_contexts' };
const MSG_REF = { table: 'lark_messages' };

/** 构造通过信封（lark.message_received）。 */
export function mapAcceptedEnvelope(evt, ctx) {
  return {
    event_id: uuid(),
    idem_key: `lark:message:${evt.message_id}`,
    event_type: 'lark.message_received',
    case_id: null,
    actor: `user:${evt.open_id}`,
    occurred_at: evt.create_time,
    payload: { message_type: evt.message_type, chat_scope: evt.chat_id, bot_mode: ctx.bot_mode },
    evidence_refs: [{ ...BOT_REF, id: evt.chat_id }, { ...MSG_REF, id: evt.message_id }],
    schema_version: 1,
  };
}

/** 构造 DENY 信封（lark.ignored）。idem_key 独立于通过事件。 */
export function mapDeniedEnvelope(evt, reason) {
  return {
    event_id: uuid(),
    idem_key: `lark:ignored:${evt.chat_id ?? 'no_scope'}:${evt.message_id}`,
    event_type: 'lark.ignored',
    case_id: null,
    actor: `user:${evt.open_id}`,
    occurred_at: evt.create_time,
    payload: { message_type: evt.message_type, chat_scope: evt.chat_id, reason },
    evidence_refs: [
      { ...BOT_REF, id: evt.chat_id ?? 'no_scope' },
      { ...MSG_REF, id: evt.message_id ?? 'malformed' },
    ],
    schema_version: 1,
  };
}
