/** upcaster.js — Step 0 事件结构版本迁移（schema_version 逐级 upcast + DLQ）。
 *
 * 权威契约: specs/001-step0-event-ledger/spec.md FR-007；
 * 低于 CURRENT_SCHEMA_VERSION 的事件按注册表逐级转换（N→N+1）；
 * 缺少注册项或转换抛错的事件落 event_dlq（reason=upcast_failed），原始负载完整保留。
 */
import { now } from '../db.js';

export const CURRENT_SCHEMA_VERSION = 1;

/** fromVersion → (envelope) => envelope(schema_version = fromVersion+1) */
const upcasts = new Map();

/** 注册 N→N+1 级转换函数（未来结构演进时在 hub 内调用，不在事件路径热注册）。 */
export function registerUpcast(fromVersion, fn) {
  upcasts.set(fromVersion, fn);
}

function toDlq(db, envelope, reason) {
  db.prepare('INSERT INTO event_dlq (event_id, raw_payload, reason, failed_at) VALUES (?, ?, ?, ?)')
    .run(envelope.event_id ?? 'unknown', JSON.stringify(envelope), reason, now());
}

/** 逐级转换至 targetVersion；缺少注册项或转换抛错 → DLQ（upcast_failed）。
 * 返回 {ok:true, event} 或 {ok:false, reason:'upcast_failed'}。
 */
export function upcastTo(db, envelope, targetVersion) {
  let evt = envelope;
  let v = evt.schema_version ?? 1;
  while (v < targetVersion) {
    const fn = upcasts.get(v);
    if (!fn) {
      toDlq(db, evt, 'upcast_failed');
      return { ok: false, reason: 'upcast_failed' };
    }
    try {
      evt = fn(evt);
      v = evt.schema_version;
    } catch {
      toDlq(db, evt, 'upcast_failed');
      return { ok: false, reason: 'upcast_failed' };
    }
  }
  return { ok: true, event: evt };
}

/** 主入口：转换至当前版本。比当前更新（未知未来结构）的事件同样不可消费，
 * 落 DLQ（reason=schema_invalid）。返回 {ok:true, event} 或 {ok:false, reason}。
 */
export function upcastEvent(db, envelope) {
  const v = envelope.schema_version ?? 1;
  if (v > CURRENT_SCHEMA_VERSION) {
    toDlq(db, envelope, 'schema_invalid');
    return { ok: false, reason: 'schema_invalid' };
  }
  return upcastTo(db, envelope, CURRENT_SCHEMA_VERSION);
}
