/** 工作台 OpenMai 状态与显式重跑接口。 */
import { currentState } from './engagement.js';
import { startOpenmaiTask, getOpenmaiResult } from './openmai-task.js';
import { nextSearchExclusions } from './search-rounds.js';
import { body, err, json } from './server-http.js';

export function openmaiRoutes(db, bus) {
  return {
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
      if (searchBrief.length > 2000) return err(res, 422, 'SEARCH_BRIEF_TOO_LONG', '岗位画像不能超过 2000 字');
      const out = startOpenmaiTask(db, bus, cid, id, {
        force: true, searchBrief, excludeCandidateRefs: nextSearchExclusions(db, id),
      });
      json(res, 200, { ok: true, openmai: out });
    },
  };
}
