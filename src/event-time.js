import { now } from './db.js';

/** 新事实的发生/收到时间。收到时间由服务器生成，发生时间可由可信导入显式提供。 */
export function eventTimes(occurredAt = null) {
  const received_at = now();
  const occurred_at = occurredAt || received_at;
  const occurredMs = Date.parse(occurred_at);
  const receivedMs = Date.parse(received_at);
  if (!Number.isFinite(occurredMs)) {
    return { ok: false, status: 422, error: 'occurred_at 必须是有效 ISO 时间' };
  }
  if (occurredMs > receivedMs) {
    return { ok: false, status: 422, error: 'occurred_at 不能晚于系统收到时间' };
  }
  return { ok: true, occurred_at: new Date(occurredMs).toISOString(), received_at };
}

/** 推荐关联是归因边界：必须同时属于同一顾问和职位。 */
export function decisionReferenceIsValid(db, consultantId, projectId, decisionId) {
  if (!decisionId) return true;
  return !!db.prepare(`SELECT 1 FROM recommendations
    WHERE decision_id=? AND consultant_id=? AND project_id=?`)
    .get(decisionId, consultantId, projectId)
    || !!db.prepare(`SELECT 1 FROM agentic_ranking_items
      WHERE decision_id=? AND consultant_id=? AND job_id=?`)
      .get(decisionId, consultantId, projectId);
}
