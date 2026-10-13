/** 工作台 OpenMai 状态与显式重跑接口。 */
import { currentState } from './engagement.js';
import { startOpenmaiTask, getOpenmaiResult } from './openmai-task.js';
import { nextSearchExclusions } from './search-rounds.js';
import { searchPrincipalForConsultant } from './candidate-search-feedback.js';
import { getProjectSearchBrief, saveProjectSearchBrief } from './project-search-brief.js';
import { body, err, json } from './server-http.js';

export function openmaiRoutes(db, bus) {
  return {
    'GET /api/v1/opportunities/:id/search-brief': (req, res, cid, q, id) => {
      if (!['ACCEPTED', 'COMPLETED'].includes(currentState(db, cid, id)?.state)) {
        return err(res, 404, 'NOT_FOUND', '职位不存在或未接单');
      }
      json(res, 200, getProjectSearchBrief(db, id));
    },
    'PUT /api/v1/opportunities/:id/search-brief': async (req, res, cid, q, id) => {
      if (!['ACCEPTED', 'COMPLETED'].includes(currentState(db, cid, id)?.state)) {
        return err(res, 404, 'NOT_FOUND', '职位不存在或未接单');
      }
      const payload = await body(req);
      if (!payload) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      try { json(res, 200, saveProjectSearchBrief(db, cid, id, payload.search_brief, payload.version)); }
      catch (error) {
        if (error.code === 'SEARCH_BRIEF_CONFLICT') return err(res, 409, error.code, '条件已被其他人更新，请刷新后重新编辑');
        if (error.code === 'SEARCH_BRIEF_INVALID') return err(res, 422, error.code, '请输入 2000 字以内条件和有效版本');
        throw error;
      }
    },
    'GET /api/v1/opportunities/:id/openmai': (req, res, cid, q, id) => {
      const st = currentState(db, cid, id)?.state;
      if (!['ACCEPTED', 'COMPLETED'].includes(st)) return err(res, 404, 'NOT_FOUND', '职位不存在或未接单');
      json(res, 200, getOpenmaiResult(db, cid, id));
    },
    'POST /api/v1/opportunities/:id/openmai/rerun': async (req, res, cid, q, id) => {
      const st = currentState(db, cid, id)?.state;
      if (!['ACCEPTED', 'COMPLETED'].includes(st)) return err(res, 404, 'NOT_FOUND', '职位不存在或未接单');
      const cur = getOpenmaiResult(db, cid, id);
      const staleMs = Date.now() - Date.parse(cur.started_at || 0);
      if (cur.status === 'running' && !(Number.isFinite(staleMs) && staleMs > 60 * 60 * 1000)) {
        return err(res, 409, 'RUNNING', '找人在进行中，请等待完成后再试');
      }
      const payload = await body(req);
      if (payload === null) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const searchBrief = String(payload?.search_brief || '').trim();
      if (searchBrief.length > 2000) return err(res, 422, 'SEARCH_BRIEF_TOO_LONG', '职位信息不能超过 2000 字');
      let out;
      try { out = startOpenmaiTask(db, bus, cid, id, {
        force: true, searchBrief,
        excludeCandidateRefs: nextSearchExclusions(db, id, searchPrincipalForConsultant(db, cid)),
      }); } catch (error) {
        if (error.code === 'SEARCH_BRIEF_TOO_LONG') return err(res, 422, error.code, '保存条件与本轮补充合计不能超过 2000 字，请精简后重试');
        throw error;
      }
      json(res, 200, { ok: true, openmai: out });
    },
  };
}
