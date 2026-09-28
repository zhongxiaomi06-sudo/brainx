/** event-ledger.js — 事件账本测试基座（specs/019-hub-event-backbone）。
 *
 * 复用既有测试建库模式：openDb(':memory:') 跑全量迁移，workflow_event_log（0023）、
 * processed_events（0024+0028 复合主键修正）、event_dlq（0027）即为生产真实结构，
 * 不手抄 DDL（避免与 migrations 漂移）。
 * 另提供快捷 appendEvent 与按类型读取（payload/evidence_refs 已解析）的辅助函数。
 */
import { openDb, now, uuid } from '../../src/db.js';
import { appendEvent } from '../../src/hub/event-log.js';

/** 开一座全新内存库（迁移跑到最新，账本三表就绪）。 */
export function createLedgerDb() {
  return openDb(':memory:');
}

/** 快捷追加事件：只传业务字段，event_id/actor/occurred_at 缺省自动补。 */
export function emitTestEvent(db, {
  event_type, idem_key, payload = {}, actor = null, case_id = null, evidence_refs = [], occurred_at = null,
}) {
  return appendEvent(db, {
    event_id: uuid(),
    idem_key,
    event_type,
    case_id,
    actor: actor || 'system:test',
    occurred_at: occurred_at || now(),
    payload,
    evidence_refs,
  });
}

/** 按 event_type 读账本（按发生时间排序，payload/evidence_refs 已解析）。 */
export function eventsByType(db, eventType) {
  return db.prepare('SELECT * FROM workflow_event_log WHERE event_type=? ORDER BY occurred_at, event_id')
    .all(eventType)
    .map((row) => ({ ...row, payload: JSON.parse(row.payload), evidence_refs: JSON.parse(row.evidence_refs) }));
}

/** 某类型事件计数。 */
export function countEvents(db, eventType) {
  return db.prepare('SELECT COUNT(*) n FROM workflow_event_log WHERE event_type=?').get(eventType).n;
}
