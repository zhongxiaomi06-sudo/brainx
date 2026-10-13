/** ranking-labels.js — 离线排序标签的时间切分契约。 */
import { negativeFeedbackAt } from './ranking-feedback.js';

export const RANKING_LABEL_VERSION = 'ranking-label-v2';

const EVENT_LABELS = { DISMISSED: 0, VIEWED: 1, WATCHED: 1, ACCEPTED: 2 };
const STAGE_LABELS = {
  推荐采纳: 3, 推荐: 3,
  面试: 4, 客户面试: 4,
  Offer: 5, offer: 5, 入职: 5, 开票: 5,
};

export function validateLabelWindow({ windowDays, cutoffAt }) {
  const days = Number(windowDays);
  const cutoffMs = Date.parse(cutoffAt);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new TypeError('windowDays 必须是 1-365 的整数');
  }
  if (!Number.isFinite(cutoffMs)) throw new TypeError('cutoffAt 必须是有效 ISO 时间');
  return { windowDays: days, cutoffAt: new Date(cutoffMs).toISOString(), cutoffMs };
}

function result(status, label, reason, context) {
  return { version: RANKING_LABEL_VERSION, status, label, reason, ...context };
}

/**
 * 只计算一条明确推荐项的贡献标签。特征时点是推荐生成；标签窗口从真实曝光开始。
 * 无关联业务事实仍保留在业务账本，但不会被猜测归因到某一推荐轮。
 */
export function evaluationLabelFor(db, decisionId, options) {
  const { windowDays, cutoffAt, cutoffMs } = validateLabelWindow(options || {});
  const rec = db.prepare(`SELECT decision_id, consultant_id, project_id, run_id
    FROM recommendations WHERE decision_id=?`).get(decisionId);
  const base = { decision_id: decisionId, window_days: windowDays, cutoff_at: cutoffAt,
    negative_reason_codes: [] };
  if (!rec) return result('EXCLUDED', null, 'MISSING_RECOMMENDATION', base);

  const impression = db.prepare(`SELECT served_at FROM recommendation_impressions
    WHERE decision_id=? ORDER BY created_at LIMIT 1`).get(decisionId);
  const servedMs = Date.parse(impression?.served_at);
  if (!impression?.served_at || !Number.isFinite(servedMs)) {
    return result('EXCLUDED', null, 'UNEXPOSED', base);
  }
  const maturesMs = servedMs + windowDays * 86400000;
  const context = { ...base, served_at: new Date(servedMs).toISOString(),
    matures_at: new Date(maturesMs).toISOString() };
  if (cutoffMs < maturesMs) return result('IMMATURE', null, 'WINDOW_OPEN', context);

  const facts = [
    ...db.prepare(`SELECT event_type AS kind, occurred_at, received_at
      FROM decision_events WHERE decision_id=?`).all(decisionId)
      .map((row) => ({ ...row, label: EVENT_LABELS[row.kind] })),
    ...db.prepare(`SELECT stage AS kind, occurred_at, received_at
      FROM job_outcomes WHERE decision_id=?`).all(decisionId)
      .map((row) => ({ ...row, label: STAGE_LABELS[row.kind] })),
  ].filter((row) => row.label !== undefined);

  for (const fact of facts) {
    const occurredMs = Date.parse(fact.occurred_at);
    const receivedMs = Date.parse(fact.received_at);
    if (!Number.isFinite(occurredMs) || !Number.isFinite(receivedMs) || receivedMs < occurredMs) {
      return result('EXCLUDED', null, 'MISSING_EVENT_TIME', context);
    }
  }
  const negative = negativeFeedbackAt(db, rec, { servedMs, maturesMs, cutoffMs });
  if (negative.invalid) return result('EXCLUDED', null, 'MISSING_EVENT_TIME', context);
  const labeledContext = { ...context, negative_reason_codes: negative.reason_codes };
  const labels = facts.filter((fact) => {
    const occurredMs = Date.parse(fact.occurred_at);
    const receivedMs = Date.parse(fact.received_at);
    return occurredMs >= servedMs && occurredMs <= maturesMs && receivedMs <= cutoffMs;
  }).map((fact) => fact.label);
  if (negative.label !== null) labels.push(negative.label);
  if (!labels.length) return result('MATURE', null, 'UNKNOWN_NO_OUTCOME', labeledContext);
  return result('MATURE', Math.max(...labels), 'LABELED', labeledContext);
}

export function labelsForRunAt(db, consultantId, runId, options) {
  return db.prepare(`SELECT decision_id, project_id, rank FROM recommendations
    WHERE run_id=? AND consultant_id=? ORDER BY rank`).all(runId, consultantId)
    .map((rec) => ({ ...rec, ...evaluationLabelFor(db, rec.decision_id, options) }));
}
