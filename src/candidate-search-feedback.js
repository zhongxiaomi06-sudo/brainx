/** 顾问确认的候选负反馈；调用方先验证项目及候选授权。 */
import { now, uuid } from './db.js';

export function setCandidateSearchFeedback(db, principal, args, sourceTaskId) {
  const status = args.action === 'REJECT_CANDIDATE' ? 'REJECTED' : 'RESTORED';
  const keys = [principal.tenantId, principal.consultantId, args.job_id, args.candidate_ref];
  const current = db.prepare(`SELECT * FROM candidate_search_feedback
    WHERE tenant_id=? AND consultant_id=? AND project_id=? AND candidate_ref=?`).get(...keys);
  if (current?.status === status) return current;
  const at = now();
  const reason = String(args.note || '').trim().slice(0, 1000) || null;
  db.exec('SAVEPOINT candidate_feedback');
  try {
    db.prepare(`INSERT INTO candidate_search_feedback
      (tenant_id,consultant_id,project_id,candidate_ref,status,reason,source_task_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,consultant_id,project_id,candidate_ref)
      DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(...keys, status, reason, sourceTaskId || null, at, at);
    db.prepare(`INSERT INTO candidate_search_feedback_events
      (event_id,tenant_id,consultant_id,project_id,candidate_ref,status,reason,source_task_id,occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(uuid(), ...keys, status, reason, sourceTaskId || null, at);
    db.exec('RELEASE candidate_feedback');
  } catch (error) { db.exec('ROLLBACK TO candidate_feedback; RELEASE candidate_feedback'); throw error; }
  return { candidate_ref: args.candidate_ref, status, reason, updated_at: at };
}

export function rejectedCandidateRefs(db, projectId, principal = {}) {
  const { tenantId, consultantId } = principal;
  if (!db || !tenantId || !consultantId) return [];
  if (String(projectId).startsWith('supermai:')) return db.prepare(`SELECT candidate_ref
    FROM freeform_candidate_decisions WHERE tenant_id=? AND consultant_id=? AND search_key=?
    AND status='REJECTED' ORDER BY updated_at DESC,candidate_ref`).all(tenantId, consultantId, projectId)
    .map(row => row.candidate_ref);
  return db.prepare(`SELECT candidate_ref FROM candidate_search_feedback
    WHERE tenant_id=? AND consultant_id=? AND project_id=? AND status='REJECTED'
    ORDER BY updated_at DESC,candidate_ref`).all(tenantId, consultantId, projectId)
    .map(row => row.candidate_ref);
}

/** 工作台由登录态提供顾问身份；只在租户绑定唯一时解析，不猜租户。 */
export function searchPrincipalForConsultant(db, consultantId) {
  const rows = db.prepare(`SELECT DISTINCT tenant_id FROM feishu_identity_bindings
    WHERE consultant_id=? AND binding_status='ACTIVE'`).all(consultantId);
  return { consultantId, tenantId: rows.length === 1 ? rows[0].tenant_id : null };
}
