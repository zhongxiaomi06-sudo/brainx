/** project-routes.js — 项目归属写入与“我的项目”读取路由。 */
import { confirmMembership } from './membership.js';
import { listProjects } from './projects.js';
import { relationOf } from './relations.js';
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
      const listedRelation = job ? relationOf(db, cid, id) : null;
      const listedInSharedPool = ['MY_JOB', 'TEAM_SHARED'].includes(listedRelation);
      if (!job || (!jobVisibleTo(db, cid, id) && !listedInSharedPool)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      try {
        const result = confirmMembership(db, cid, id, input);
        if (!result.ok) return err(res, result.status || 422, 'MEMBERSHIP_UPDATE_REJECTED', result.error);
        const project = listProjects(db, cid, { projectId: id })[0] || null;
        json(res, 200, {
          ...result,
          project,
          recompute: { blocked: false, deferred: !result.already },
        });
      } catch (error) {
        err(res, 500, 'MEMBERSHIP_UPDATE_FAILED', String(error.message).slice(0, 300));
      }
    },
  };
}
