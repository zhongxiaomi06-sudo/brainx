/** TTC 数据源路由：凭据托管、扩展同步与字段覆盖率查询。 */
import { body, err, json } from './server-http.js';
import { loadConsultants } from './recommend.js';
import { latestTtcFieldReport } from './ttc-field-report.js';
import { validateJwt, saveTtcToken, ttcAuthStatus } from './ttcsdk/auth.js';

export { ttcAuthStatus };
import { quota as ttcQuota } from './ttcsdk/user.js';
import { TtcApiError } from './ttcsdk/http.js';

async function verifyAndSave(db, consultantId, jwt) {
  let meta;
  try { meta = validateJwt(jwt); } catch (error) {
    return { status: 422, code: 'BAD_JWT', message: error.message };
  }
  try { await ttcQuota(jwt); } catch (error) {
    if (error instanceof TtcApiError && error.authInvalid) {
      return { status: 401, code: 'TTC_AUTH_INVALID', message: 'JWT 无效或已失效——回 TTC 系统重新登录后再试' };
    }
    return { status: 502, code: 'TTC_UNREACHABLE', message: '连不上 TTC 接口，稍后再试' };
  }
  saveTtcToken(db, consultantId, jwt, meta);
  return { status: 200, value: { ok: true, consultant_id: consultantId, ...ttcAuthStatus(db, consultantId) } };
}

export function ttcRoutes(db) {
  const consultantExists = (id) => loadConsultants(db).some((consultant) => consultant.consultant_id === id);
  return {
    'GET /api/v1/ttc/connect': (req, res, cid) => json(res, 200, ttcAuthStatus(db, cid)),
    'GET /api/v1/ttc/field-report': (req, res, cid) => json(res, 200, {
      report: latestTtcFieldReport(db, cid),
    }),
    'PUT /api/v1/ttc/connect': async (req, res, cid) => {
      const payload = await body(req);
      const jwt = String(payload?.jwt || '').trim();
      if (!jwt) return err(res, 400, 'EMPTY', '没收到 JWT');
      if (jwt.length > 8192) return err(res, 400, 'TOO_LONG', '长度异常，确认只复制了 token 值');
      const out = await verifyAndSave(db, cid, jwt);
      if (!out.value) return err(res, out.status, out.code, out.message);
      json(res, 200, out.value);
    },
    'DELETE /api/v1/ttc/connect': (req, res, cid) => {
      db.prepare('DELETE FROM ttc_tokens WHERE consultant_id=?').run(cid);
      json(res, 200, { ok: true, connected: false });
    },
    'GET /api/v1/ttc/status': (req, res, cid, query) => {
      const consultantId = query.get('consultant_id') || 'felix';
      if (!consultantExists(consultantId)) return err(res, 404, 'NOT_FOUND', '顾问不存在');
      json(res, 200, ttcAuthStatus(db, consultantId));
    },
    'POST /api/v1/ttc/ext-sync': async (req, res) => {
      const origin = String(req.headers.origin || '');
      const referer = String(req.headers.referer || '');
      const extension = origin.startsWith('chrome-extension://') || referer.startsWith('chrome-extension://');
      const local = /^https?:\/\/(127\.0\.0\.1|localhost):/.test(origin)
        || /^https?:\/\/(127\.0\.0\.1|localhost):/.test(referer);
      if (!extension && !local) return err(res, 403, 'FORBIDDEN', '仅接受浏览器扩展或本地来源');
      const payload = await body(req);
      const jwt = String(payload?.jwt || '').trim();
      const consultantId = String(payload?.consultant_id || payload?.consultantId || 'felix').trim();
      if (!jwt) return err(res, 400, 'EMPTY', '没收到 JWT');
      if (jwt.length > 8192) return err(res, 400, 'TOO_LONG', '长度异常，确认只发送了 token 值');
      if (!consultantExists(consultantId)) return err(res, 422, 'BAD_CONSULTANT', '顾问不存在，请在扩展里选择正确的顾问');
      const out = await verifyAndSave(db, consultantId, jwt);
      if (!out.value) return err(res, out.status, out.code, out.message);
      json(res, 200, out.value);
    },
  };
}
