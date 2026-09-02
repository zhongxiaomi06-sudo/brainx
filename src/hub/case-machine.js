/** case-machine.js — Step 0 Case 双轴状态机（advanceCase，乐观锁推进）。
 *
 * 权威契约: specs/001-step0-event-ledger/spec.md FR-003 与 data-model.md 合法迁移表。
 * milestone 轴只允许相邻步进；非法跳跃拒绝并落 case.transition_rejected 事件留痕；
 * UPDATE ... WHERE version=? 行数为 0 即乐观锁冲突，显式失败不静默。
 */
import { now, uuid } from '../db.js';
import { appendEvent } from './event-log.js';

export const MILESTONE_PATH = [
  'DISCOVERED',
  'QUALIFIED',
  'CONSENTED',
  'SUBMITTED',
  'INTERVIEW',
  'OFFER',
  'PLACED',
];

export const OUTREACH_PATH = ['NOT_CONTACTED', 'SENT', 'DELIVERED', 'REPLIED'];

const SELECT_CASE_SQL = 'SELECT * FROM cases WHERE case_id = ?';
const ADVANCE_SQL =
  'UPDATE cases SET milestone = ?, version = ?, updated_at = ? WHERE case_id = ? AND version = ?';

function recordCaseEvent(db, eventType, c, to) {
  return appendEvent(db, {
    event_id: uuid(),
    idem_key: `${eventType}:${c.case_id}:${c.version}:${c.milestone}->${to}`,
    event_type: eventType,
    case_id: c.case_id,
    actor: `system:case-machine`,
    occurred_at: now(),
    payload: { from: c.milestone, to },
    evidence_refs: [{ table: 'cases', id: c.case_id }],
  });
}

/** 沿 milestone 轴推进 Case 至 toMilestone（仅限相邻合法步）。
 * opts.caseRow：可选的调用方预读快照；传入时以快照 version 做乐观锁比对
 * （模拟"读取后其他写入者已推进"的并发冲突，命中即 version_conflict）。
 * 返回 {ok:true, from, to, version} 或 {ok:false, reason}。
 */
export function advanceCase(db, caseId, toMilestone, opts = {}) {
  const c = opts.caseRow ?? db.prepare(SELECT_CASE_SQL).get(caseId);
  if (!c || c.case_id !== caseId) return { ok: false, reason: 'case_not_found' };
  const fromIdx = MILESTONE_PATH.indexOf(c.milestone);
  const toIdx = MILESTONE_PATH.indexOf(toMilestone);
  if (fromIdx === -1 || toIdx !== fromIdx + 1) {
    recordCaseEvent(db, 'case.transition_rejected', c, toMilestone);
    return { ok: false, reason: 'illegal_transition', from: c.milestone, to: toMilestone };
  }
  const nextVersion = c.version + 1;
  const res = db
    .prepare(ADVANCE_SQL)
    .run(toMilestone, nextVersion, now(), caseId, c.version);
  if (res.changes === 0) return { ok: false, reason: 'version_conflict', from: c.milestone };
  recordCaseEvent(db, 'case.stage_advanced', { ...c, version: nextVersion }, toMilestone);
  return { ok: true, from: c.milestone, to: toMilestone, version: nextVersion };
}
