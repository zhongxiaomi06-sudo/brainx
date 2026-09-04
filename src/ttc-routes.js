/** TTC 数据源路由：凭据托管、扩展同步与字段覆盖率查询。
 * 2026-09-04 账号隔离加固（强制本人登陆）：凭据只许绑本人——JWT 内嵌身份
 * （ttc_user_name）必须与目标顾问花名册 display_name 一致，跨人代绑一律 422 拒绝。
 * ext-sync 不再有默认顾问（原来缺参默认 felix），必须显式指定本人 consultant_id。
 */
import { body, err, json } from './server-http.js';
import { latestTtcFieldReport } from './ttc-field-report.js';
import { validateJwt, saveTtcToken, ttcAuthStatus } from './ttcsdk/auth.js';

export { ttcAuthStatus };
import { quota as ttcQuota } from './ttcsdk/user.js';
import { TtcApiError } from './ttcsdk/http.js';

const normName = (v) => String(v || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** 强制本人账号：JWT 归属（内嵌 nick_name）与目标顾问必须一致，fail-closed。
 * 任何跨人代绑（拿别人的 token 填进自己的槽位、或反向）都在落库前拒绝。 */
function ownershipError(db, consultantId, meta) {
  const row = db.prepare('SELECT display_name FROM consultants WHERE consultant_id=? AND active=1').get(consultantId);
  if (!row) return { status: 404, code: 'BAD_CONSULTANT', message: '顾问不存在' };
  if (!meta.userName || normName(meta.userName) !== normName(row.display_name)) {
    return { status: 422, code: 'JWT_OWNER_MISMATCH',
      message: `该 JWT 属于「${meta.userName || '未知身份'}」，与目标顾问「${row.display_name}」不一致——`
        + '请回 TTC 系统用本人账号登录后复制自己的 token' };
  }
  return null;
}

async function verifyAndSave(db, consultantId, jwt) {
  let meta;
  try { meta = validateJwt(jwt); } catch (error) {
    return { status: 422, code: 'BAD_JWT', message: error.message };
  }
  const ownerErr = ownershipError(db, consultantId, meta); // 先验归属，再打 TTC 活探针
  if (ownerErr) return ownerErr;
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
    // 状态只回本人（cid 来自登录会话）；跨人查询参数一律忽略——原来可传 ?consultant_id= 查任何人
    'GET /api/v1/ttc/status': (req, res, cid) => json(res, 200, ttcAuthStatus(db, cid)),
    'POST /api/v1/ttc/ext-sync': async (req, res) => {
      const origin = String(req.headers.origin || '');
      const referer = String(req.headers.referer || '');
      const extension = origin.startsWith('chrome-extension://') || referer.startsWith('chrome-extension://');
      const local = /^https?:\/\/(127\.0\.0\.1|localhost):/.test(origin)
        || /^https?:\/\/(127\.0\.0\.1|localhost):/.test(referer);
      if (!extension && !local) return err(res, 403, 'FORBIDDEN', '仅接受浏览器扩展或本地来源');
      const payload = await body(req);
      const jwt = String(payload?.jwt || '').trim();
      const consultantId = String(payload?.consultant_id || payload?.consultantId || '').trim();
      if (!jwt) return err(res, 400, 'EMPTY', '没收到 JWT');
      if (jwt.length > 8192) return err(res, 400, 'TOO_LONG', '长度异常，确认只发送了 token 值');
      // 不再默认 felix：扩展必须显式选择本人顾问，且 JWT 归属必须与该顾问一致
      if (!consultantId) return err(res, 422, 'BAD_CONSULTANT', '未指定顾问——请在扩展设置里选择本人账号对应的顾问');
      const out = await verifyAndSave(db, consultantId, jwt);
      if (!out.value) return err(res, out.status, out.code, out.message);
      json(res, 200, out.value);
    },
  };
}
