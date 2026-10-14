/** 项目找人轮次：从已交付结果提取 TTC 编号，作为下一轮累计排除名单。 */
import { extractOpenmaiCandidates } from './openmai-result.js';
import { rejectedCandidateRefs } from './candidate-search-feedback.js';

const SAFE_REF = /^[A-Za-z0-9:_-]{1,100}$/;

export function normalizeExcludedCandidateRefs(values) {
  const refs = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => SAFE_REF.test(value)))];
  // 引擎最多接受 100 人；静默截断会让长期排除的人重新出现并产生付费搜索。
  if (refs.length > 100) throw new Error('SEARCH_EXCLUSIONS_OVER_LIMIT');
  return refs;
}

function storedRefs(value) {
  let parsed;
  try { parsed = JSON.parse(value || '[]'); }
  catch { return []; }
  return normalizeExcludedCandidateRefs(parsed);
}

function hasTtcTalentUrl(candidate) {
  try {
    const target = new URL(candidate.talentUrl);
    return target.origin === 'https://app.ttcadvisory.com'
      && target.pathname.startsWith('/app/talent/');
  } catch { return false; }
}

function resultRefs(row) {
  const assumeTtc = String(row.task_id || '').startsWith('om_');
  return extractOpenmaiCandidates(row.result_text)
    .filter((candidate) => candidate.candidateRefValid && (assumeTtc || hasTtcTalentUrl(candidate)))
    .map((candidate) => candidate.candidateRef);
}

function allResultRefs(row) {
  return extractOpenmaiCandidates(row.result_text)
    .filter((candidate) => candidate.candidateRefValid)
    .map((candidate) => candidate.candidateRef);
}

function projectRows(db, projectId, principal) {
  if (String(projectId).startsWith('supermai:')) {
    if (!principal?.consultantId) return [];
    return db.prepare(`SELECT task_id,result_text,excluded_candidate_refs_json
      FROM openmai_results WHERE project_id=? AND consultant_id=?
      ORDER BY finished_at DESC,started_at DESC`).all(projectId, principal.consultantId);
  }
  return db.prepare(`SELECT task_id,result_text,excluded_candidate_refs_json
    FROM openmai_results WHERE project_id IN (?,?)
    ORDER BY finished_at DESC,started_at DESC`).all(projectId, `supermai-result:${projectId}`);
}

export function nextSearchExclusions(db, projectId, principal) {
  const rows = projectRows(db, projectId, principal);
  return normalizeExcludedCandidateRefs([...rejectedCandidateRefs(db, projectId, principal), ...rows.flatMap((row) => [
    ...storedRefs(row.excluded_candidate_refs_json), ...resultRefs(row),
  ])]);
}

export function nextSupermaiSearchExclusions(db, projectId, principal) {
  const rows = projectRows(db, projectId, principal);
  return normalizeExcludedCandidateRefs([...rejectedCandidateRefs(db, projectId, principal), ...rows.flatMap((row) => [
    ...storedRefs(row.excluded_candidate_refs_json), ...allResultRefs(row),
  ])]);
}
