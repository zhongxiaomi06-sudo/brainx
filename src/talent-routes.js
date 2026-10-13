/** 人才库与职位人才供给 HTTP 路由；持久层策略仍由 talent.js 统一裁决。 */
import { existsSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { body, err, isPathInside, json } from './server-http.js';
import { jobVisibleTo } from './visibility.js';
import {
  getTalent,
  ingestResume,
  listResumes,
  listTalents,
  syncTalentsFromCsv,
  syncTalentsFromResumes,
  talentBackendStatus,
  talentHealth,
} from './talent.js';
import { talentSupplyEnabled, talentSupplyForJob } from './talent-supply.js';

export function talentRoutes(db, { rootDir } = {}) {
  if (!rootDir) throw new TypeError('TALENT_ROUTE_ROOT_REQUIRED');
  return {
    'GET /api/v1/talent/status': async (req, res) => {
      try {
        json(res, 200, { ...(await talentBackendStatus()), supply_enabled: talentSupplyEnabled() });
      } catch (error) {
        err(res, 502, 'TALENT_BACKEND_ERROR', String(error.message).slice(0, 200));
      }
    },
    'GET /api/v1/talent/health': async (req, res) => {
      try { json(res, 200, await talentHealth()); }
      catch (error) { err(res, 502, 'TALENT_HEALTH_ERROR', String(error.message).slice(0, 200)); }
    },
    'GET /api/v1/talent': async (req, res, cid, query) => {
      try {
        const items = await listTalents({
          limit: query.get('limit'),
          offset: query.get('offset'),
          status: query.get('status') || null,
        });
        json(res, 200, { items });
      } catch (error) {
        err(res, 502, 'TALENT_LIST_FAILED', String(error.message).slice(0, 200));
      }
    },
    'GET /api/v1/talent/:id': async (req, res, cid, query, id) => {
      try {
        const talent = await getTalent(id);
        if (!talent) return err(res, 404, 'NOT_FOUND', '候选人不存在');
        json(res, 200, talent);
      } catch (error) {
        err(res, 502, 'TALENT_GET_FAILED', String(error.message).slice(0, 200));
      }
    },
    'POST /api/v1/talent/sync': async (req, res) => {
      const input = await body(req);
      const csvPath = input?.csv_path
        ? join(rootDir, input.csv_path)
        : join(rootDir, '公司岗位情况-Shanon - Sheet1.csv');
      if (!isPathInside(rootDir, normalize(csvPath)) || !existsSync(csvPath)) {
        return err(res, 422, 'BAD_CSV', 'CSV 路径不合法或不存在');
      }
      try {
        json(res, 200, await syncTalentsFromCsv(csvPath, { createdBy: null }));
      } catch (error) {
        err(res, 502, 'TALENT_SYNC_FAILED', String(error.message).slice(0, 300));
      }
    },
    'POST /api/v1/talent/resume': async (req, res) => {
      const input = await body(req);
      const text = input?.text;
      if (!text || !String(text).trim()) {
        return err(res, 422, 'EMPTY_RESUME', '简历内容为空');
      }
      try {
        const output = await ingestResume(String(text), {
          fileName: input?.file_name || '', createdBy: null,
        });
        json(res, 200, output);
      } catch (error) {
        err(res, 502, 'RESUME_INGEST_FAILED', String(error.message).slice(0, 300));
      }
    },
    'POST /api/v1/talent/resumes': async (req, res) => {
      const input = await body(req);
      const resumes = Array.isArray(input?.resumes)
        ? input.resumes.map((resume) => ({ text: resume.text, fileName: resume.file_name })) : [];
      if (!resumes.length) return err(res, 422, 'NO_RESUMES', '未提供简历');
      try {
        json(res, 200, await syncTalentsFromResumes(resumes, { createdBy: null }));
      } catch (error) {
        err(res, 502, 'RESUMES_SYNC_FAILED', String(error.message).slice(0, 300));
      }
    },
    'GET /api/v1/talent/:id/resumes': async (req, res, cid, query, id) => {
      try { json(res, 200, { items: await listResumes(id) }); }
      catch (error) { err(res, 502, 'RESUME_LIST_FAILED', String(error.message).slice(0, 200)); }
    },
    'GET /api/v1/opportunities/:id/talent-supply': async (req, res, cid, query, id) => {
      const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(id);
      if (!job || !jobVisibleTo(db, cid, id)) {
        return err(res, 404, 'NOT_FOUND', '职位不存在');
      }
      try {
        const snapshot = await talentSupplyForJob({
          project_id: job.project_id,
          company: job.company,
          role: job.role,
          notes: job.notes,
        });
        json(res, 200, snapshot);
      } catch (error) {
        err(res, 502, 'TALENT_SUPPLY_FAILED', String(error.message).slice(0, 200));
      }
    },
  };
}
