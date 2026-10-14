/** 顾问确认的候选负反馈；调用方先验证项目及候选授权。 */
import { now, uuid } from './db.js';

// 复用既有自由搜索决策表的保留作用域；原搜索/职位记录仍原样保留供审计。
const GLOBAL_SCOPE = 'consultant:all-searches';

export function setGlobalCandidateDecision(db, principal, candidateRef, status, sourceTaskId) {
  const keys = [principal.tenantId, principal.consultantId, GLOBAL_SCOPE, candidateRef];
  const current = db.prepare(`SELECT status FROM freeform_candidate_decisions
    WHERE tenant_id=? AND consultant_id=? AND search_key=? AND candidate_ref=?`).get(...keys);
  if (current?.status === status) return false;
  const at = now();
  db.prepare(`INSERT INTO freeform_candidate_decisions VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,consultant_id,search_key,candidate_ref)
    DO UPDATE SET status=excluded.status,source_task_id=excluded.source_task_id,updated_at=excluded.updated_at`)
    .run(...keys, status, sourceTaskId || `decision:${candidateRef}`, at);
  db.prepare('INSERT INTO freeform_candidate_events VALUES (?,?,?,?,?,?,?,?)')
    .run(uuid(), ...keys, status, sourceTaskId || `decision:${candidateRef}`, at);
  db.prepare(`UPDATE sourcing_candidates SET career_status=?, updated_at=?
    WHERE consultant_id=? AND candidate_ref=?`)
    .run(status === 'REJECTED' ? 'rejected' : 'restored', at, principal.consultantId, candidateRef);
  return true;
}

export function setCandidateSearchFeedback(db, principal, args, sourceTaskId) {
  const status = args.action === 'REJECT_CANDIDATE' ? 'REJECTED' : 'RESTORED';
  const keys = [principal.tenantId, principal.consultantId, args.job_id, args.candidate_ref];
  const current = db.prepare(`SELECT * FROM candidate_search_feedback
    WHERE tenant_id=? AND consultant_id=? AND project_id=? AND candidate_ref=?`).get(...keys);
  if (current?.status === status) {
    db.exec('SAVEPOINT candidate_feedback');
    try { setGlobalCandidateDecision(db, principal, args.candidate_ref, status, sourceTaskId);
      db.exec('RELEASE candidate_feedback'); }
    catch (error) { db.exec('ROLLBACK TO candidate_feedback; RELEASE candidate_feedback'); throw error; }
    return current;
  }
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
    setGlobalCandidateDecision(db, principal, args.candidate_ref, status, sourceTaskId);
    db.exec('RELEASE candidate_feedback');
  } catch (error) { db.exec('ROLLBACK TO candidate_feedback; RELEASE candidate_feedback'); throw error; }
  return { candidate_ref: args.candidate_ref, status, reason, updated_at: at };
}

export function rejectedCandidateRefs(db, projectId, principal = {}) {
  const { tenantId, consultantId } = principal;
  if (!db || !tenantId || !consultantId) return [];
  // 旧版按单个搜索/职位写入的决策也纳入本人全域；新的全域标记优先于旧状态。
  return db.prepare(`WITH decisions AS (
    SELECT candidate_ref,status,updated_at,2 priority FROM freeform_candidate_decisions
      WHERE tenant_id=? AND consultant_id=? AND search_key=?
    UNION ALL
    SELECT candidate_ref,status,updated_at,1 priority FROM freeform_candidate_decisions
      WHERE tenant_id=? AND consultant_id=? AND search_key!=? AND status IN ('REJECTED','RESTORED')
    UNION ALL
    SELECT candidate_ref,status,updated_at,1 priority FROM candidate_search_feedback
      WHERE tenant_id=? AND consultant_id=?
  ), latest AS (
    SELECT candidate_ref,status,ROW_NUMBER() OVER
      (PARTITION BY candidate_ref ORDER BY priority DESC,updated_at DESC,status DESC) rank
    FROM decisions
  ) SELECT candidate_ref FROM latest WHERE rank=1 AND status='REJECTED' ORDER BY candidate_ref`)
    .all(tenantId, consultantId, GLOBAL_SCOPE, tenantId, consultantId, GLOBAL_SCOPE,
      tenantId, consultantId)
    .map(row => row.candidate_ref);
}

/** 工作台由登录态提供顾问身份；只在租户绑定唯一时解析，不猜租户。 */
export function searchPrincipalForConsultant(db, consultantId) {
  const rows = db.prepare(`SELECT DISTINCT tenant_id FROM feishu_identity_bindings
    WHERE consultant_id=? AND binding_status='ACTIVE'`).all(consultantId);
  return { consultantId, tenantId: rows.length === 1 ? rows[0].tenant_id : null };
}
