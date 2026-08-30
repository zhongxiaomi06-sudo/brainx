/** membership.js — 顾问确认职位归属；关系历史只关闭、只追加。 */
import { now } from './db.js';
import { currentState, legalActions } from './engagement.js';

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
    return { ok: true, already: true, relation,
      legal_actions: legalActions(db, consultant_id, project_id).filter((action) => action !== 'VIEW') };
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
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { ok: true, already: false, relation,
    legal_actions: legalActions(db, consultant_id, project_id).filter((action) => action !== 'VIEW') };
}

export function removeMembership(db, consultant_id, project_id, { idempotency_key = '' } = {}) {
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    return { ok: false, status: 400, error: '缺 idempotency_key' };
  }
  if (idempotency_key.length > 200) {
    return { ok: false, status: 400, error: 'idempotency_key 过长' };
  }
  const current = db.prepare(`SELECT id, relation FROM job_memberships
    WHERE consultant_id=? AND project_id=? AND valid_to IS NULL
      AND relation IN ('MY_JOB','TEAM_SHARED')
    ORDER BY id DESC LIMIT 1`).get(consultant_id, project_id);
  if (!current) return { ok: true, already: true, removed: false };

  const state = currentState(db, consultant_id, project_id).state;
  if (!['NEW', 'RECOMMENDED', 'VIEWED', 'DISMISSED', 'RELEASED', 'EXPIRED'].includes(state)) {
    return { ok: false, status: 409, error: '项目已有关注或跟进行动，请先在详情中结束当前动作' };
  }
  db.prepare('UPDATE job_memberships SET valid_to=? WHERE id=? AND valid_to IS NULL')
    .run(now(), current.id);
  return { ok: true, already: false, removed: true };
}
