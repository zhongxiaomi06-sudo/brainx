/** “忽略”事实：从所有工作列表排除职位，但不删除职位、归属历史或事件账本。 */
import { now } from './db.js';
import { decisionReferenceIsValid } from './event-time.js';
import { appendFeedbackEvent } from './ranking-feedback.js';

function inTransaction(db, operation) {
  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    const result = operation();
    if (ownsTransaction) {
      if (result?.ok === false) db.exec('ROLLBACK');
      else db.exec('COMMIT');
    }
    return result;
  } catch (error) {
    if (ownsTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

export function ignoredProjectIds(db, consultant_id) {
  return new Set(db.prepare(`SELECT project_id FROM opportunity_ignores
    WHERE consultant_id=?`).all(consultant_id).map((row) => row.project_id));
}

export function isOpportunityIgnored(db, consultant_id, project_id) {
  return !!db.prepare(`SELECT 1 FROM opportunity_ignores
    WHERE consultant_id=? AND project_id=?`).get(consultant_id, project_id);
}

export function recordOpportunityIgnore(db, consultant_id, project_id, idempotency_key, {
  decision_id = null, reason = '', source = 'OPPORTUNITY_IGNORE', occurred_at = null,
  force_event = false,
} = {}) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return { ok: false, status: 400, error: '缺 idempotency_key' };
  }
  if (!decisionReferenceIsValid(db, consultant_id, project_id, decision_id)) {
    return { ok: false, status: 422, error: 'decision_id 与当前顾问或职位不匹配' };
  }
  const eventDuplicate = db.prepare(`SELECT 1 FROM recommendation_feedback_events
    WHERE idempotency_key=?`).get(idempotency_key);
  if (eventDuplicate) {
    return appendFeedbackEvent(db, consultant_id, project_id, {
      decision_id, event_type: 'NEGATIVE', reason, source, occurred_at, idempotency_key,
    });
  }
  const duplicate = db.prepare(`SELECT consultant_id, project_id FROM opportunity_ignores
    WHERE idempotency_key=?`).get(idempotency_key);
  if (duplicate) {
    if (duplicate.consultant_id !== consultant_id || duplicate.project_id !== project_id) {
      return { ok: false, status: 409, error: 'idempotency_key 已用于其他职位' };
    }
    return { ok: true, already: true, ignored: true };
  }
  const current = db.prepare(`SELECT 1 FROM opportunity_ignores
    WHERE consultant_id=? AND project_id=?`).get(consultant_id, project_id);
  if (current && !force_event) return { ok: true, already: true, ignored: true };
  return inTransaction(db, () => {
    const event = appendFeedbackEvent(db, consultant_id, project_id, {
      decision_id, event_type: 'NEGATIVE', reason, source, occurred_at, idempotency_key,
    });
    if (!event.ok || event.already) return event;
    if (!current) {
      db.prepare(`INSERT INTO opportunity_ignores
        (consultant_id, project_id, idempotency_key, ignored_at)
        VALUES (?,?,?,?)`).run(consultant_id, project_id, idempotency_key, now());
    }
    return { ...event, ignored: true };
  });
}

export function revokeOpportunityIgnore(db, consultant_id, project_id, {
  decision_id = null, source = 'OPPORTUNITY_RESTORED', occurred_at = null,
  idempotency_key = '',
} = {}) {
  if (decision_id && !decisionReferenceIsValid(db, consultant_id, project_id, decision_id)) {
    return { ok: false, status: 422, error: 'decision_id 与当前顾问或职位不匹配' };
  }
  if (idempotency_key) {
    const duplicate = db.prepare(`SELECT 1 FROM recommendation_feedback_events
      WHERE idempotency_key=?`).get(idempotency_key);
    if (duplicate) {
      return appendFeedbackEvent(db, consultant_id, project_id, {
        decision_id, event_type: 'REVOKED', source, occurred_at, idempotency_key,
      });
    }
  }
  const exists = db.prepare(`SELECT 1 FROM opportunity_ignores
      WHERE consultant_id=? AND project_id=?
    UNION ALL SELECT 1 FROM recommendation_feedback
      WHERE consultant_id=? AND project_id=? LIMIT 1`)
    .get(consultant_id, project_id, consultant_id, project_id);
  if (!exists) return { ok: true, already: false, removed: false };
  return inTransaction(db, () => {
    let event = { ok: true, already: false };
    if (idempotency_key) {
      event = appendFeedbackEvent(db, consultant_id, project_id, {
        decision_id, event_type: 'REVOKED', source, occurred_at, idempotency_key,
      });
      if (!event.ok || event.already) return event;
    }
    const ignored = db.prepare(`DELETE FROM opportunity_ignores
      WHERE consultant_id=? AND project_id=?`).run(consultant_id, project_id).changes;
    const feedback = db.prepare(`DELETE FROM recommendation_feedback
      WHERE consultant_id=? AND project_id=?`).run(consultant_id, project_id).changes;
    return { ...event, removed: ignored + feedback > 0 };
  });
}

export function clearOpportunityIgnore(db, consultant_id, project_id, options = {}) {
  const result = revokeOpportunityIgnore(db, consultant_id, project_id, options);
  return result.ok && !!result.removed;
}
