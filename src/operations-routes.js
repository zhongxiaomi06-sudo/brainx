/** 管理员运营看板路由：GET 只读投影，投影/重建显式分离。 */
import { body, err, json } from './server-http.js';
import {
  projectOperationsDashboard,
  readOperationsDashboard,
  traceOperationsMetric,
} from './operations-dashboard.js';

export function isOperationsAdmin(options, consultantId) {
  const admins = options.operationsAdmins
    || String(process.env.BRAINX_AGENT_ADMIN_ALLOWLIST || '').split(',')
      .map((value) => value.trim()).filter(Boolean);
  return admins.includes(consultantId);
}

export function operationsRoutes(db, options = {}) {
  const tenantId = options.operationsTenantId || 'brainx';
  const allowed = (res, consultantId) => {
    if (isOperationsAdmin(options, consultantId)) return true;
    err(res, 403, 'ADMIN_FORBIDDEN', '无管理员权限');
    return false;
  };
  return {
    'GET /api/v1/admin/operations/dashboard': (req, res, consultantId) => {
      if (!allowed(res, consultantId)) return;
      json(res, 200, readOperationsDashboard(db, tenantId));
    },
    'POST /api/v1/admin/operations/project': async (req, res, consultantId) => {
      if (!allowed(res, consultantId)) return;
      const input = await body(req);
      if (input === null) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      json(res, 200, projectOperationsDashboard(db, {
        tenantId, rebuild: input?.rebuild === true,
      }));
    },
    'GET /api/v1/admin/operations/events': (req, res, consultantId, query) => {
      if (!allowed(res, consultantId)) return;
      try {
        json(res, 200, traceOperationsMetric(db, {
          tenantId, metric: query.get('metric'), limit: query.get('limit'),
        }));
      } catch (error) {
        err(res, 422, 'TRACE_METRIC_INVALID', '不支持的指标追溯');
      }
    },
  };
}
