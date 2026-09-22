/** emit.js — 业务事件发射辅助（specs/019-hub-event-backbone）。
 *
 * 包装 event-log.js 的 appendEvent：统一 actor/occurred_at/schema_version 缺省约定，
 * 返回 {ok, deduplicated, event}（appendEvent 原样结果，deduplicated=true 表示幂等命中既有行）。
 * 事件形状唯一权威契约: specs/019-hub-event-backbone/contracts/event-types.md。
 * 本模块不开事务：业务写入点（confirm/replay 等）多在自有 BEGIN/COMMIT 内调用，
 * appendEvent 的单条 INSERT 随调用方事务同生死，失败即回滚。
 */
import { now, uuid } from '../db.js';
import { appendEvent } from './event-log.js';

/** 发射业务事件。idem_key 必须复用业务写入点既有幂等键（契约 research.md 决策 3）。 */
export function emitEvent(db, {
  event_type, idem_key, actor = null, payload = {}, case_id = null, evidence_refs = [], occurred_at = null,
}) {
  return appendEvent(db, {
    event_id: uuid(),
    idem_key,
    event_type,
    case_id,
    actor: actor || 'system:worker',
    occurred_at: occurred_at || now(),
    payload,
    evidence_refs,
    schema_version: 1,
  });
}

/** 发射并要求成功——信封无效/超大属程序错误，抛错让调用方事务回滚（不静默丢事件）。 */
export function mustEmitEvent(db, input) {
  const result = emitEvent(db, input);
  if (!result.ok) throw new Error(`EVENT_EMIT_FAILED:${result.reason}`);
  return result;
}
