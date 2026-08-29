/** project-routes.js — 项目归属写入与“我的项目”读取路由。 */
import { confirmMembership } from './membership.js';
import { listProjects } from './projects.js';
import { recommend } from './recommend.js';
import { jobVisibleTo } from './visibility.js';
import { body, err, json } from './server-http.js';

export function projectRoutes(db) {
  return {
    'GET /api/v1/projects': (req, res, cid) => {
      const items = listProjects(db, cid);
      json(res, 200, { items, total_count: items.length });
    },
    'PATCH /api/v1/opportunities/:id/membership': async (req, res, cid, q, id) => {
      const job = db.prepare('SELECT 1 FROM job_facts WHERE project_id=?').get(id);
      if (!job || !jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      try {
        const result = confirmMembership(db, cid, id, input);
        if (!result.ok) return err(res, result.status || 422, 'MEMBERSHIP_UPDATE_REJECTED', result.error);
        const project = listProjects(db, cid).find((item) => item.project_id === id) || null;
        let recompute = { blocked: false };
        if (!result.already) {
          try {
            const rec = recommend(db, cid, { top: 20 });
            if (rec?.blocked) recompute = { blocked: true, reason: rec.reason };
          } catch (error) {
            recompute = { blocked: true, reason: `项目已加入，推荐刷新失败：${String(error.message).slice(0, 160)}` };
          }
        }
        json(res, 200, {
          ...result,
          project,
          recompute,
        });
      } catch (error) {
        err(res, 500, 'MEMBERSHIP_UPDATE_FAILED', String(error.message).slice(0, 300));
      }
    },
  };
}
