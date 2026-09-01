/** event-log.js — Step 0 append-only 事件账本写入（appendEvent）。
 *
 * 权威契约: specs/001-step0-event-ledger/spec.md FR-001/FR-005/FR-006；
 * 生产者幂等由 idx_wel_idem 唯一索引兜底：INSERT 冲突时读回既有行返回。
 * append-only：本模块不提供任何 UPDATE/DELETE 路径。
 */
import { validateEnvelope } from './envelope.js';

const MAX_PAYLOAD_BYTES = 64 * 1024; // 边界用例：账本存引用不存大对象

const INSERT_SQL = `
  INSERT INTO workflow_event_log
    (event_id, idem_key, event_type, case_id, actor, occurred_at, payload, evidence_refs, schema_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_BY_IDEM_SQL = 'SELECT * FROM workflow_event_log WHERE idem_key = ?';

/** 追加事件。input 为未校验信封；返回 {ok:true, event, deduplicated} 或 {ok:false, reason, errors?}。 */
export function appendEvent(db, input) {
  const v = validateEnvelope(input);
  if (!v.ok) return v;
  const e = v.value;
  const payloadJson = JSON.stringify(e.payload);
  if (Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
    return { ok: false, reason: 'payload_too_large' };
  }
  const refsJson = JSON.stringify(e.evidence_refs ?? []);
  try {
    db.prepare(INSERT_SQL).run(
      e.event_id,
      e.idem_key,
      e.event_type,
      e.case_id ?? null,
      e.actor,
      e.occurred_at,
      payloadJson,
      refsJson,
      e.schema_version,
    );
  } catch (err) {
    // node:sqlite 唯一冲突表现为 code=ERR_SQLITE_ERROR + message "UNIQUE constraint failed: ..."
    if (err.code === 'ERR_SQLITE_ERROR' && /UNIQUE constraint failed/.test(err.message)) {
      return { ok: true, event: db.prepare(SELECT_BY_IDEM_SQL).get(e.idem_key), deduplicated: true };
    }
    throw err;
  }
  return { ok: true, event: db.prepare(SELECT_BY_IDEM_SQL).get(e.idem_key), deduplicated: false };
}
