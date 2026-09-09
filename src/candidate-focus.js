/** 项目共享候选人重点名单：持久化引用，并从项目找人结果恢复群内可见摘要。 */
import { now } from './db.js';
import { extractOpenmaiCandidates } from './openmai-result.js';
import { normalizeExcludedCandidateRefs } from './search-rounds.js';

function validCandidateRef(value) {
  return normalizeExcludedCandidateRefs([value])[0] || null;
}

function candidateSnapshot(candidate) {
  if (!candidate) return null;
  return {
    name: candidate.name || null,
    role: candidate.role || null,
    experience: candidate.experience || null,
    city: candidate.city || null,
    education: candidate.education || null,
    evaluation: candidate.evaluation || null,
    score: candidate.score || null,
  };
}

function parseSnapshot(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function projectSearchCandidate(db, jobId, candidateRef) {
  const ref = validCandidateRef(candidateRef);
  if (!ref) return null;
  const results = db.prepare(`SELECT task_id,result_text FROM openmai_results
    WHERE project_id=? AND status IN ('done','needs_input')
    ORDER BY finished_at DESC, started_at DESC`).all(jobId);
  for (const result of results) {
    const candidate = extractOpenmaiCandidates(result.result_text)
      .find((item) => item.candidateRefValid !== false && item.candidateRef === ref);
    if (candidate) return { ...candidate, sourceTaskId: result.task_id || null };
  }
  return null;
}

export function setProjectCandidateFocus(db, input, focused, at = now()) {
  const ref = validCandidateRef(input.candidateRef);
  if (!ref) throw Object.assign(new Error('INVALID_ARGUMENT'), { code: 'INVALID_ARGUMENT' });
  const existing = db.prepare(`SELECT created_at FROM project_candidate_focus
    WHERE tenant_id=? AND position_id=? AND candidate_ref=?`)
    .get(input.tenantId, input.jobId, ref);
  if (!focused && !existing) throw Object.assign(new Error('NOT_FOUND_OR_FORBIDDEN'),
    { code: 'NOT_FOUND_OR_FORBIDDEN' });
  const snapshotJson = JSON.stringify(candidateSnapshot(input.candidateSnapshot) || {});
  db.prepare(`INSERT INTO project_candidate_focus
    (tenant_id,position_id,candidate_ref,focus_status,selected_by,source_task_id,
     candidate_snapshot_json,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,position_id,candidate_ref) DO UPDATE SET
      focus_status=excluded.focus_status,selected_by=excluded.selected_by,
      source_task_id=COALESCE(excluded.source_task_id,project_candidate_focus.source_task_id),
      candidate_snapshot_json=CASE WHEN excluded.candidate_snapshot_json='{}'
        THEN project_candidate_focus.candidate_snapshot_json ELSE excluded.candidate_snapshot_json END,
      updated_at=excluded.updated_at`).run(
    input.tenantId, input.jobId, ref, focused ? 'FOCUSED' : 'REMOVED',
    input.consultantId, input.sourceTaskId || null, snapshotJson, existing?.created_at || at, at,
  );
  return db.prepare(`SELECT position_id job_ref,candidate_ref,focus_status,source_task_id,
      created_at,updated_at FROM project_candidate_focus
    WHERE tenant_id=? AND position_id=? AND candidate_ref=?`)
    .get(input.tenantId, input.jobId, ref);
}

export function listProjectCandidateFocus(db, tenantId, jobId) {
  if (!db || !tenantId || !jobId) return [];
  const rows = db.prepare(`SELECT candidate_ref,source_task_id,candidate_snapshot_json,created_at,updated_at
    FROM project_candidate_focus WHERE tenant_id=? AND position_id=? AND focus_status='FOCUSED'
    ORDER BY updated_at DESC,candidate_ref`).all(tenantId, jobId);
  return rows.map((row) => {
    const candidate = projectSearchCandidate(db, jobId, row.candidate_ref);
    const snapshot = { ...parseSnapshot(row.candidate_snapshot_json),
      ...(candidateSnapshot(candidate) || {}) };
    return {
      candidate_ref: row.candidate_ref,
      name: snapshot.name || null,
      role: snapshot.role || null,
      experience: snapshot.experience || null,
      city: snapshot.city || null,
      education: snapshot.education || null,
      evaluation: snapshot.evaluation || null,
      score: snapshot.score || null,
      source_task_id: row.source_task_id || candidate?.sourceTaskId || null,
      focused_at: row.updated_at,
    };
  });
}
