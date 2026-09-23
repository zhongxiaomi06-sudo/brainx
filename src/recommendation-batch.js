import { now, uuid } from './db.js';
import { createRecommendationUseCase } from './recommendation-use-case.js';
import { effectiveJob } from './facts.js';
import { currentState } from './engagement.js';
import { isOpportunityIgnored, recordOpportunityIgnore,
  revokeOpportunityIgnore } from './opportunity-ignore.js';
import { appendFeedbackEvent } from './ranking-feedback.js';

const LIMIT = 20;

function transact(db, operation) {
  db.exec('BEGIN');
  try {
    const result = operation();
    if (result?.ok === false) db.exec('ROLLBACK');
    else db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function batchFor(db, consultantId, snapshotId, size = LIMIT) {
  let batch = db.prepare('SELECT * FROM recommendation_batches WHERE consultant_id=? AND snapshot_id=?').get(consultantId, snapshotId);
  if (!batch) {
    const at = now();
    const batchId = `batch_${uuid()}`;
    db.prepare(`INSERT INTO recommendation_batches
      (batch_id, consultant_id, snapshot_id, cursor, size, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?)`).run(batchId, consultantId, snapshotId, 0, Math.min(size, LIMIT), at, at);
    batch = db.prepare('SELECT * FROM recommendation_batches WHERE batch_id=?').get(batchId);
  } else {
    // 后续更大的 size 请求不被创建时值静默锁死
    const want = Math.min(size, LIMIT);
    if (want > batch.size) {
      db.prepare('UPDATE recommendation_batches SET size=?, updated_at=? WHERE batch_id=?')
        .run(want, now(), batch.batch_id);
      batch = { ...batch, size: want };
    }
  }
  return batch;
}

function isHidden(db, consultantId, item) {
  if (isOpportunityIgnored(db, consultantId, item.job.project_id)) return true;
  const feedback = db.prepare(`SELECT 1 FROM recommendation_feedback
    WHERE consultant_id=? AND project_id=? LIMIT 1`).get(consultantId, item.job.project_id);
  if (feedback) return true;
  const state = currentState(db, consultantId, item.job.project_id);
  if (state.state === 'ACCEPTED') return true;
  return ['CLOSED', 'COMPLETED', 'COOLING'].includes(item.job.active_state);
}

function page(db, consultantId, batch, cursor, recommendations) {
  const run = recommendations.latest(consultantId);
  if (!run || run.run.snapshot_id !== batch.snapshot_id) return { items: [], next_cursor: null, has_more: false };
  const size = Math.min(Number(batch.size) || LIMIT, LIMIT);
  const all = run.items.filter((item) => !isHidden(db, consultantId, item));
  const items = all.slice(cursor, cursor + size);
  const next = cursor + items.length;
  return { items, next_cursor: next < all.length ? String(next) : null, has_more: next < all.length };
}

export function pickTray(db, consultantId, { limit = LIMIT, cursor } = {}, {
  recommendations = createRecommendationUseCase(db),
} = {}) {
  const run = recommendations.latest(consultantId);
  if (!run) return { snapshot_id: null, batch_id: null, items: [], next_cursor: null, has_more: false };
  const batch = batchFor(db, consultantId, run.run.snapshot_id, Math.min(Number(limit) || LIMIT, LIMIT));
  const requested = cursor == null || cursor === '' ? batch.cursor : Math.max(0, Number(cursor) || 0);
  if (requested !== batch.cursor) db.prepare('UPDATE recommendation_batches SET cursor=?, updated_at=? WHERE batch_id=?').run(requested, now(), batch.batch_id);
  const result = page(db, consultantId, batch, requested, recommendations);
  return { snapshot_id: run.run.snapshot_id, batch_id: batch.batch_id, items: result.items,
    next_cursor: result.next_cursor, has_more: result.has_more, cursor: String(requested) };
}

export function nextBatch(db, consultantId, body, {
  recommendations = createRecommendationUseCase(db),
} = {}) {
  const run = recommendations.latest(consultantId);
  if (!run) return { ok: false, status: 409, code: 'NO_RECOMMENDATION', message: '暂无完整推荐快照' };
  const batch = batchFor(db, consultantId, run.run.snapshot_id, body?.size || LIMIT);
  const current = Math.max(0, Number(body?.cursor ?? batch.cursor) || 0);
  const currentPage = page(db, consultantId, batch, current, recommendations);
  const next = current + currentPage.items.length;
  db.prepare('UPDATE recommendation_batches SET cursor=?, updated_at=? WHERE batch_id=?').run(next, now(), batch.batch_id);
  const result = page(db, consultantId, batch, next, recommendations);
  return { ok: true, snapshot_id: run.run.snapshot_id, batch_id: batch.batch_id, items: result.items,
    next_cursor: result.next_cursor, has_more: result.has_more, cursor: String(next) };
}

export function feedback(db, consultantId, body, {
  recommendations = createRecommendationUseCase(db),
} = {}) {
  if (!body?.project_id || body.feedback !== 'NOT_INTERESTED' || !body.reason || !body.idempotency_key) {
    return { ok: false, status: 422, code: 'INVALID_FEEDBACK', message: '需要 project_id、NOT_INTERESTED、reason 和 idempotency_key' };
  }
  const existing = db.prepare('SELECT * FROM recommendation_feedback WHERE idempotency_key=?').get(body.idempotency_key);
  if (existing) return { ok: true, already: true, feedback_id: existing.feedback_id,
    replacement: pickTray(db, consultantId, { limit: LIMIT }, { recommendations }) };
  const run = recommendations.latest(consultantId);
  const item = run?.items.find((entry) => entry.job.project_id === body.project_id);
  if (!item) return { ok: false, status: 404, code: 'NOT_IN_SNAPSHOT', message: '职位不在当前冻结推荐快照中' };
  const batch = batchFor(db, consultantId, run.run.snapshot_id, LIMIT);
  // 2026-08-19：同顾问+职位+快照已有反馈时更新 reason（"补充原因"场景：
  // 点 × 先记默认 reason，toast「补充原因」二次提交用户自定义文本），不插新行。
  const existingForProject = db.prepare(`SELECT * FROM recommendation_feedback
    WHERE consultant_id=? AND project_id=? AND snapshot_id=?`).get(consultantId, body.project_id, run.run.snapshot_id);
  if (existingForProject) {
    const corrected = transact(db, () => {
      const event = appendFeedbackEvent(db, consultantId, body.project_id, {
        decision_id: body.decision_id || null, event_type: 'REASON_CORRECTED',
        reason: body.reason, source: 'RECOMMENDATION_FEEDBACK',
        occurred_at: body.occurred_at || null, idempotency_key: body.idempotency_key,
      });
      if (!event.ok || event.already) return event;
      db.prepare('UPDATE recommendation_feedback SET reason=?, created_at=? WHERE feedback_id=?')
        .run(String(body.reason).slice(0, 200), now(), existingForProject.feedback_id);
      return { ...event, updated: true };
    });
    if (!corrected.ok || corrected.already) return { ...corrected,
      replacement: pickTray(db, consultantId, { limit: LIMIT }, { recommendations }) };
    return { ok: true, updated: true, feedback_id: existingForProject.feedback_id,
      replacement: pickTray(db, consultantId, { limit: LIMIT }, { recommendations }) };
  }
  const feedbackId = `feedback_${uuid()}`;
  const recorded = transact(db, () => {
    const ignored = recordOpportunityIgnore(db, consultantId, body.project_id, body.idempotency_key, {
      decision_id: body.decision_id || null, reason: body.reason,
      source: 'RECOMMENDATION_FEEDBACK', occurred_at: body.occurred_at || null,
      force_event: true,
    });
    if (!ignored.ok || ignored.already) return ignored;
    db.prepare(`INSERT INTO recommendation_feedback
      (feedback_id, consultant_id, project_id, snapshot_id, batch_id, feedback, reason, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(feedbackId, consultantId, body.project_id, run.run.snapshot_id, body.batch_id || batch.batch_id,
        body.feedback, String(body.reason).slice(0, 200), body.idempotency_key, now());
    return { ...ignored, feedback_id: feedbackId };
  });
  if (!recorded.ok || recorded.already) return { ...recorded,
    replacement: pickTray(db, consultantId, { limit: LIMIT }, { recommendations }) };
  return { ok: true, feedback_id: feedbackId,
    replacement: pickTray(db, consultantId, { limit: LIMIT }, { recommendations }) };
}

// 撤销"不感兴趣"：删除该顾问在当前快照下对该职位的 feedback 记录。
// 与 feedback 路由成对使用（小红书/B站式：点不感兴趣立即隐藏，toast 带撤销）。
// 幂等：无记录时 removed=false，仍返回 ok（前端无需区分）。
export function undoFeedback(db, consultantId, body, {
  recommendations = createRecommendationUseCase(db),
} = {}) {
  if (!body?.project_id) {
    return { ok: false, status: 422, code: 'INVALID_UNDO', message: '需要 project_id' };
  }
  const run = recommendations.latest(consultantId);
  if (!run) return { ok: false, status: 409, code: 'NO_RECOMMENDATION', message: '暂无完整推荐快照' };
  const current = db.prepare(`SELECT feedback_id, idempotency_key FROM recommendation_feedback
    WHERE consultant_id=? AND project_id=? ORDER BY created_at DESC LIMIT 1`)
    .get(consultantId, body.project_id);
  const ignored = db.prepare(`SELECT idempotency_key FROM opportunity_ignores
    WHERE consultant_id=? AND project_id=?`).get(consultantId, body.project_id);
  const idempotencyKey = body.idempotency_key
    || (current ? `feedback-undo:${current.feedback_id}`
      : ignored ? `feedback-undo:${ignored.idempotency_key}` : '');
  const revoked = revokeOpportunityIgnore(db, consultantId, body.project_id, {
    decision_id: body.decision_id || null, source: 'RECOMMENDATION_FEEDBACK_UNDO',
    occurred_at: body.occurred_at || null, idempotency_key: idempotencyKey,
  });
  return { ...revoked,
    replacement: pickTray(db, consultantId, { limit: LIMIT }, { recommendations }) };
}
