/** ranking-feedback.js — 负反馈追加事件、稳定原因码与时间切片回放。 */
import { uuid } from './db.js';
import { decisionReferenceIsValid, eventTimes } from './event-time.js';

export const NEGATIVE_REASON_CODES = Object.freeze({
  NO_CAPACITY: 'NO_CAPACITY',
  DIRECTION_MISMATCH: 'DIRECTION_MISMATCH',
  JOB_QUALITY: 'JOB_QUALITY',
  OTHER_CONSULTANT: 'OTHER_CONSULTANT',
  INSUFFICIENT_INFO: 'INSUFFICIENT_INFO',
  OTHER: 'OTHER',
});

const EVENT_TYPES = new Set(['NEGATIVE', 'REVOKED', 'REASON_CORRECTED']);

export function negativeReasonCode(reason) {
  const text = String(reason || '').trim();
  if (/无资源|没精力|资源不足|优先级/.test(text)) return NEGATIVE_REASON_CODES.NO_CAPACITY;
  if (/方向|职能|行业|城市|地点/.test(text)) return NEGATIVE_REASON_CODES.DIRECTION_MISMATCH;
  if (/质量|客户|职位|岗位|HC|需求/.test(text)) return NEGATIVE_REASON_CODES.JOB_QUALITY;
  if (/其他顾问|他人推进|重复/.test(text)) return NEGATIVE_REASON_CODES.OTHER_CONSULTANT;
  if (/信息|不完整|待确认|不清楚/.test(text)) return NEGATIVE_REASON_CODES.INSUFFICIENT_INFO;
  return NEGATIVE_REASON_CODES.OTHER;
}

export function appendFeedbackEvent(db, consultantId, projectId, {
  decision_id = null, event_type, reason = '', reason_code = null,
  source = 'UNKNOWN', occurred_at = null, idempotency_key = '',
} = {}) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return { ok: false, status: 400, error: '缺 idempotency_key' };
  }
  if (!EVENT_TYPES.has(event_type)) return { ok: false, status: 422, error: '反馈事件类型无效' };
  const duplicate = db.prepare(`SELECT event_id, consultant_id, project_id, decision_id, event_type
    FROM recommendation_feedback_events WHERE idempotency_key=?`).get(idempotency_key);
  if (duplicate) {
    const same = duplicate.consultant_id === consultantId && duplicate.project_id === projectId
      && (duplicate.decision_id || null) === (decision_id || null) && duplicate.event_type === event_type;
    return same ? { ok: true, already: true, event_id: duplicate.event_id }
      : { ok: false, status: 409, error: 'idempotency_key 已用于其他反馈事件' };
  }
  if (!decisionReferenceIsValid(db, consultantId, projectId, decision_id)) {
    return { ok: false, status: 422, error: 'decision_id 与当前顾问或职位不匹配' };
  }
  const times = eventTimes(occurred_at);
  if (!times.ok) return times;
  const eventId = `feedback_event_${uuid()}`;
  const reasonText = event_type === 'REVOKED' ? null : String(reason || '').trim().slice(0, 200) || null;
  const reasonCode = event_type === 'REVOKED' ? null
    : (reason_code || negativeReasonCode(reasonText));
  if (event_type !== 'REVOKED' && !Object.values(NEGATIVE_REASON_CODES).includes(reasonCode)) {
    return { ok: false, status: 422, error: '负反馈原因码无效' };
  }
  db.prepare(`INSERT INTO recommendation_feedback_events
    (event_id, consultant_id, project_id, decision_id, event_type, reason_code,
     reason_text, source, occurred_at, received_at, idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(eventId, consultantId, projectId, decision_id, event_type, reasonCode,
      reasonText, String(source || 'UNKNOWN').slice(0, 50), times.occurred_at,
      times.received_at, idempotency_key);
  return { ok: true, already: false, event_id: eventId, reason_code: reasonCode };
}

/** 只让无关联撤销影响已绑定的负反馈；无关联负反馈本身不产生推荐标签。 */
export function negativeFeedbackAt(db, recommendation, { servedMs, maturesMs, cutoffMs }) {
  const rows = db.prepare(`SELECT rowid, decision_id, event_type, reason_code, occurred_at, received_at
    FROM recommendation_feedback_events
    WHERE consultant_id=? AND project_id=?
      AND (decision_id=? OR (decision_id IS NULL AND event_type='REVOKED'))`)
    .all(recommendation.consultant_id, recommendation.project_id, recommendation.decision_id);
  for (const row of rows) {
    const occurredMs = Date.parse(row.occurred_at);
    const receivedMs = Date.parse(row.received_at);
    if (!Number.isFinite(occurredMs) || !Number.isFinite(receivedMs) || receivedMs < occurredMs) {
      return { invalid: true, label: null, reason_codes: [] };
    }
  }
  const eligible = rows.filter((row) => {
    const occurredMs = Date.parse(row.occurred_at);
    const receivedMs = Date.parse(row.received_at);
    return occurredMs >= servedMs && occurredMs <= maturesMs && receivedMs <= cutoffMs;
  }).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at)
    || Date.parse(left.received_at) - Date.parse(right.received_at) || left.rowid - right.rowid);
  let active = false;
  let reasonCode = null;
  for (const event of eligible) {
    if (event.event_type === 'NEGATIVE') { active = true; reasonCode = event.reason_code; }
    if (event.event_type === 'REASON_CORRECTED' && active) reasonCode = event.reason_code;
    if (event.event_type === 'REVOKED') { active = false; reasonCode = null; }
  }
  return { invalid: false, label: active ? 0 : null,
    reason_codes: active && reasonCode ? [reasonCode] : [] };
}
