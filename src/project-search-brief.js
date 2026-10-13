import { now } from './db.js';

export function getProjectSearchBrief(db, projectId) {
  return db.prepare('SELECT search_brief,version,updated_by,updated_at FROM project_search_briefs WHERE project_id=?')
    .get(projectId) || { search_brief: '', version: 0, updated_by: null, updated_at: null };
}

export function saveProjectSearchBrief(db, consultantId, projectId, text, version) {
  if (typeof text !== 'string' || text.trim().length > 2000 || !Number.isInteger(version) || version < 0) {
    throw Object.assign(new Error('SEARCH_BRIEF_INVALID'), { code: 'SEARCH_BRIEF_INVALID' });
  }
  const at = now();
  const result = version === 0
    ? db.prepare(`INSERT INTO project_search_briefs(project_id,search_brief,version,updated_by,updated_at)
        VALUES (?,?,1,?,?) ON CONFLICT(project_id) DO NOTHING`).run(projectId, text.trim(), consultantId, at)
    : db.prepare(`UPDATE project_search_briefs SET search_brief=?,version=version+1,updated_by=?,updated_at=?
        WHERE project_id=? AND version=?`).run(text.trim(), consultantId, at, projectId, version);
  if (!result.changes) throw Object.assign(new Error('SEARCH_BRIEF_CONFLICT'), { code: 'SEARCH_BRIEF_CONFLICT' });
  return getProjectSearchBrief(db, projectId);
}

export function effectiveSearchBrief(db, projectId, supplement = '') {
  const canonical = getProjectSearchBrief(db, projectId).search_brief.trim();
  const extra = String(supplement || '').trim();
  const result = canonical && extra && canonical !== extra
    ? `权威找人条件：${canonical}\n本轮补充（不得覆盖权威硬条件）：${extra}` : canonical || extra;
  if (result.length > 2000) throw Object.assign(new Error('SEARCH_BRIEF_TOO_LONG'), { code: 'SEARCH_BRIEF_TOO_LONG' });
  return result;
}
