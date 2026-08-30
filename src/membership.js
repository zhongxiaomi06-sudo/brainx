/** membership.js — 顾问确认职位归属；关系历史只关闭、只追加。 */
import { now } from './db.js';
import { legalActions } from './engagement.js';
import { clearOpportunityIgnore, recordOpportunityIgnore } from './opportunity-ignore.js';

const ALLOWED_RELATIONS = new Set(['MY_JOB', 'TEAM_SHARED']);
const LOCKED_RELATIONS = new Set(['PRIMARY_PM', 'OTHER_CONSULTANT']);

export function confirmMembership(db, consultant_id, project_id, {
  relation,
  idempotency_key = '',
} = {}) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return { ok: false, status: 400, error: '缺 idempotency_key' };
  }
  if (idempotency_key.length > 200) {
    return { ok: false, status: 400, error: 'idempotency_key 过长' };
  }
  if (!ALLOWED_RELATIONS.has(relation)) {
    return { ok: false, status: 422, error: '项目归属只允许 MY_JOB 或 TEAM_SHARED' };
  }
  if (!db.prepare('SELECT 1 FROM job_facts WHERE project_id=?').get(project_id)) {
    return { ok: false, status: 404, error: '职位不存在' };
  }

  const current = db.prepare(`SELECT relation, source FROM job_memberships
    WHERE consultant_id=? AND project_id=? AND valid_to IS NULL
    ORDER BY id DESC LIMIT 1`).get(consultant_id, project_id);
  if (current?.relation === relation) {
    clearOpportunityIgnore(db, consultant_id, project_id);
    return { ok: true, already: true, relation,
      legal_actions: legalActions(db, consultant_id, project_id) };
  }
  if (current && LOCKED_RELATIONS.has(current.relation)) {
    return { ok: false, status: 409, error: '该职位已有明确负责人，不能直接改写项目归属' };
  }

  const at = now();
  db.exec('BEGIN');
  try {
    db.prepare(`UPDATE job_memberships SET valid_to=?
      WHERE consultant_id=? AND project_id=? AND valid_to IS NULL`).run(at, consultant_id, project_id);
    db.prepare(`INSERT INTO job_memberships
      (consultant_id, project_id, relation, source, valid_from)
      VALUES (?,?,?,?,?)`).run(consultant_id, project_id, relation, 'MANUAL_CONFIRMATION', at);
    clearOpportunityIgnore(db, consultant_id, project_id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { ok: true, already: false, relation,
    legal_actions: legalActions(db, consultant_id, project_id) };
}

export function removeMembership(db, consultant_id, project_id, { idempotency_key = '' } = {}) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return { ok: false, status: 400, error: '缺 idempotency_key' };
  }
  if (idempotency_key.length > 200) {
    return { ok: false, status: 400, error: 'idempotency_key 过长' };
  }
  if (!db.prepare('SELECT 1 FROM job_facts WHERE project_id=?').get(project_id)) {
    return { ok: false, status: 404, error: '职位不存在' };
  }
  const current = db.prepare(`SELECT id, relation FROM job_memberships
    WHERE consultant_id=? AND project_id=? AND valid_to IS NULL
      AND relation IN ('MY_JOB','TEAM_SHARED')
    ORDER BY id DESC LIMIT 1`).get(consultant_id, project_id);
  const activeAction = db.prepare(`SELECT 1 FROM commitment_actions
    WHERE consultant_id=? AND project_id=? AND status IN ('OPEN','BLOCKED') LIMIT 1`)
    .get(consultant_id, project_id);
  if (activeAction) {
    return { ok: false, status: 409, error: '项目已有跟进行动，请先完成或释放当前行动' };
  }
  db.exec('BEGIN');
  try {
    const ignored = recordOpportunityIgnore(db, consultant_id, project_id, idempotency_key);
    if (!ignored.ok) { db.exec('ROLLBACK'); return ignored; }
    const removed = current
      ? db.prepare('UPDATE job_memberships SET valid_to=? WHERE id=? AND valid_to IS NULL')
        .run(now(), current.id).changes > 0
      : false;
    db.exec('COMMIT');
    return { ...ignored, removed };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
