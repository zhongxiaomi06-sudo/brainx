/** 顾问登录页、飞书 OAuth 与本地开发 session 路由。 */
import { body, err, json } from './server-http.js';
import { signSession } from './session.js';
import { signState, verifyState, buildAuthorizeUrl,
  exchangeCode as defaultExchangeCode, oauthConfigured } from './oauth.js';
import { findByOpenId, listConsultants } from './roster.js';
import { saveUserTokens } from './feishu.js';

const LOGIN_MESSAGES = Object.freeze({
  bad_state: '登录状态校验失败（页面打开太久或重复回调），请重新扫码。',
  no_code: '飞书没有返回授权码，请重新扫码。',
  exchange_failed: '授权码换令牌失败（App Secret 配置或网络问题），请稍后重试。',
  not_in_roster: '你的飞书账号不在顾问花名册内——请联系管理员加入 roster。',
});

function loginPage(errorCode) {
  const message = errorCode
    ? (LOGIN_MESSAGES[errorCode] || '登录过程出现未知错误，请重试。') : '';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>Brain X · 顾问登录</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;font-family:Inter,'PingFang SC',system-ui,sans-serif">
<div style="width:min(420px,calc(100% - 32px));padding:36px 32px;border-radius:22px;background:#fff;border:1px solid rgba(31,49,83,.12);box-shadow:0 18px 60px rgba(28,42,73,.08)">
<p style="margin:0 0 8px;color:#176B58;font-size:12px;font-weight:700;letter-spacing:.14em">BRAIN X · 顾问登录</p>
<h1 style="margin:0 0 12px;font-size:26px;letter-spacing:-.03em;color:#172034">飞书扫码登录工作台</h1>
<p style="margin:0 0 22px;color:#6c768c;font-size:13px;line-height:1.7">使用你的飞书账号扫码授权。登录后可查看你有权限的职位推荐、承接状态与 OpenMai 自动找人结果。</p>
${message ? `<div style="margin:0 0 18px;padding:12px 14px;border-radius:12px;border:1px solid rgba(198,75,89,.18);background:rgba(198,75,89,.07);color:#c64b59;font-size:13px;line-height:1.6"><b>登录未成功：</b>${message}</div>` : ''}
<a href="/api/v1/oauth/authorize" style="display:block;text-decoration:none;text-align:center;border:0;border-radius:12px;padding:13px 16px;background:#176B58;color:#fff;font-size:14px;font-weight:700">飞书扫码 / 授权登录</a>
<p style="margin:16px 0 0;text-align:center"><a href="/" style="color:#6c768c;font-size:13px;text-decoration:none">先看看演示模式 →</a></p>
</div></body></html>`;
}

export function authRoutes(db, {
  exchangeCode: exchange = defaultExchangeCode,
  devAuth = process.env.BRAINX_DEV_AUTH === '1',
} = {}) {
  return {
    'GET /login': (req, res, cid, query) => {
      const html = loginPage(query.get('error') || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    },
    'GET /api/v1/oauth/status': (req, res) => {
      json(res, 200, { configured: oauthConfigured(), dev_auth: devAuth });
    },
    'GET /api/v1/oauth/authorize': (req, res) => {
      if (!oauthConfigured()) {
        return err(res, 503, 'OAUTH_NOT_CONFIGURED',
          '缺 BRAINX_FEISHU_APP_SECRET（从 1Password 导出后 export 再启动服务）');
      }
      res.writeHead(302, { Location: buildAuthorizeUrl(signState()) });
      res.end();
    },
    'GET /api/v1/oauth/callback': async (req, res, cid, query) => {
      const fail = (code) => {
        res.writeHead(302, { Location: `/login?error=${code}` });
        res.end();
      };
      if (!verifyState(query.get('state'))) return fail('bad_state');
      const code = query.get('code');
      if (!code) return fail('no_code');
      let identity;
      try { identity = await exchange(code); }
      catch { return fail('exchange_failed'); }
      const consultant = findByOpenId(db, identity.open_id);
      if (!consultant) return fail('not_in_roster');
      try { saveUserTokens(db, consultant.consultant_id, identity.open_id, identity.tokens); }
      catch (error) {
        console.error(`[oauth] 令牌入库失败 cid=${consultant.consultant_id}：${String(error.message).slice(0, 80)}`);
      }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `brainx_session=${encodeURIComponent(signSession(consultant.consultant_id, identity.open_id))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
      });
      res.end();
    },
    'POST /api/v1/session': async (req, res) => {
      if (!devAuth) return err(res, 403, 'DEV_AUTH_OFF', '请使用飞书账号登录');
      const input = await body(req);
      const known = listConsultants(db)
        .some((consultant) => consultant.consultant_id === input?.consultant_id);
      if (!known) return err(res, 422, 'UNKNOWN_CONSULTANT', '未知顾问身份');
      res.writeHead(204, {
        'Set-Cookie': `brainx_session=${encodeURIComponent(signSession(input.consultant_id))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
      });
      res.end();
    },
    'DELETE /api/v1/session': (req, res) => {
      res.writeHead(204, {
        'Set-Cookie': 'brainx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
      });
      res.end();
    },
  };
}
