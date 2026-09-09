/** 项目找人轮次：从已交付结果提取 TTC 编号，作为下一轮累计排除名单。 */
import { extractOpenmaiCandidates } from './openmai-result.js';

const SAFE_REF = /^[A-Za-z0-9:_-]{1,100}$/;

export function normalizeExcludedCandidateRefs(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter((value) => SAFE_REF.test(value)))].slice(0, 100);
}

function storedRefs(value) {
  try { return normalizeExcludedCandidateRefs(JSON.parse(value || '[]')); }
  catch { return []; }
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

export function nextSearchExclusions(db, projectId) {
  const rows = db.prepare(`SELECT task_id,result_text,excluded_candidate_refs_json
    FROM openmai_results WHERE project_id=? ORDER BY finished_at DESC,started_at DESC`).all(projectId);
  return normalizeExcludedCandidateRefs(rows.flatMap((row) => [
    ...storedRefs(row.excluded_candidate_refs_json), ...resultRefs(row),
  ]));
}
