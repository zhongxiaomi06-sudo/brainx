/** “忽略”事实：从所有工作列表排除职位，但不删除职位、归属历史或事件账本。 */
import { now } from './db.js';

export function ignoredProjectIds(db, consultant_id) {
  return new Set(db.prepare(`SELECT project_id FROM opportunity_ignores
    WHERE consultant_id=?`).all(consultant_id).map((row) => row.project_id));
}

export function isOpportunityIgnored(db, consultant_id, project_id) {
  return !!db.prepare(`SELECT 1 FROM opportunity_ignores
    WHERE consultant_id=? AND project_id=?`).get(consultant_id, project_id);
}

export function recordOpportunityIgnore(db, consultant_id, project_id, idempotency_key) {
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
  if (current) return { ok: true, already: true, ignored: true };
  db.prepare(`INSERT INTO opportunity_ignores
    (consultant_id, project_id, idempotency_key, ignored_at)
    VALUES (?,?,?,?)`).run(consultant_id, project_id, idempotency_key, now());
  return { ok: true, already: false, ignored: true };
}

export function clearOpportunityIgnore(db, consultant_id, project_id) {
  return db.prepare(`DELETE FROM opportunity_ignores
    WHERE consultant_id=? AND project_id=?`).run(consultant_id, project_id).changes > 0;
}
