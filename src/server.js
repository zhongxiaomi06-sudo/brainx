/** server.js — HTTP API + 静态工作台（补全文档 §16 契约）。
 * 零框架 node:http。除 session/consultants/oauth 外全部要登录 Cookie。
 */
import './env.js';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now } from './db.js';
import { runSync, latestSync, latestRealSync, latestBridgeError, latestCompleteSnapshot, friendlyBridgeError } from './sync.js';
import { recommend, latestRun, loadConsultants } from './recommend.js';
import { engage, commitmentSummary, currentState, legalActions, DISMISS_REASONS } from './engagement.js';
import { replay, recordOutcome } from './replay.js';
import { acceptCommitment, commitmentDetails, recordProgress, recordTerminalResult,
  releaseCommitment, suggestedAction, RELEASE_REASONS, CLOSE_REASONS } from './commitment.js';
import { buildDailyCard, buildSyncAlertCard, pushCard } from './push.js';
import { signSession, verifySession, cookieOf } from './session.js';
import { signState, verifyState, buildAuthorizeUrl, exchangeCode, oauthConfigured } from './oauth.js';
import { findByOpenId, updateProfile } from './roster.js';
import { startBridge } from './bridge.js';
import { startScheduler } from './scheduler.js';
import { makeAutoPush } from './autopush.js';
import { saveUserTokens, tokenStatus } from './feishu.js';
import { jobVisibleTo } from './visibility.js';
import { relationOf } from './relations.js';
import { projectRoutes } from './project-routes.js';
import { startOpenmaiTask, getOpenmaiResult } from './openmai-task.js';
import { radarPayload, clientRows } from './radar.js';
import { ttcFieldReportForSync } from './ttc-field-report.js';
import { ttcAuthStatus, ttcRoutes } from './ttc-routes.js';
import { syncTalentsFromCsv, listTalents as listTalentsRepo, getTalent, talentBackendStatus, ingestResume, syncTalentsFromResumes, listResumes, talentHealth } from './talent.js';
import { talentSupplyForJob, talentSupplyEnabled } from './talent-supply.js';
import { effectiveJob, effectiveFactPayload, updateFactOverrides } from './facts.js';
import { assistantRoutes } from './assistant-routes.js';
import { pickTray, nextBatch, feedback as recommendationFeedback, undoFeedback as recommendationUndoFeedback } from './recommendation-batch.js';
import { recommendationPage } from './recommendation-page.js';
import { verifyQuick, quickResultPage, QUICK_ACTIONS } from './quickfb.js';
import { verifySnapshotKey, jobSnapshot } from './snapshot.js';
import { createGuard } from './guard.js';
import { makeClientErrorRoute } from './client-error.js';
import { body, err, isPathInside, json, normalizeWorkbenchPreferences, proxyFrontend,
  safeJsonArray, STATIC_MIME } from './server-http.js';

export { isPathInside } from './server-http.js';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_DIR = join(ROOT, 'frontend', 'btex-frontend');
const FRONTEND_HOST = process.env.BRAINX_FRONTEND_HOST || '127.0.0.1';
const FRONTEND_PORT = Number(process.env.BRAINX_FRONTEND_PORT || 4321);
// 本地静态资源目录：vinext 在部分环境（Windows）不提供 /assets，后端直接读 dist 产物绕过
const STATIC_DIR = join(FRONTEND_DIR, 'dist', 'client');
export function createServer(db = openDb(), deps = {}) {
  const exchange = deps.exchangeCode || exchangeCode;
  const devAuth = process.env.BRAINX_DEV_AUTH === '1';
  // 请求指标（预测告警装置数据源）：仅聚合数字，无业务数据，经 /api/v1/meta/guard 暴露
  const guard = createGuard();
  const auth = (req, res) => {
    const s = verifySession(cookieOf(req));
    if (!s) err(res, 401, 'UNAUTHORIZED', '未登录或会话已过期');
    return s?.consultant_id || null;
  };

  // SSE 广播总线：res → consultant_id；事件带 consultant_id 时只发给本人（定向隔离）
  const sseClients = new Map();
  const bus = {
    emit(obj) {
      const frame = `data: ${JSON.stringify(obj)}\n\n`;
      for (const [res, ccid] of [...sseClients]) {
        if (obj.consultant_id && obj.consultant_id !== ccid) continue;
        try { res.write(frame); } catch { sseClients.delete(res); }
      }
    },
    clientCount: () => sseClients.size,
  };

  const routes = {
    ...assistantRoutes(db, deps),
    ...projectRoutes(db),
    'GET /api/v1/consultants': (req, res) => {
      json(res, 200, { items: loadConsultants(db)
        .map((c) => ({ consultant_id: c.consultant_id, display_name: c.display_name })) });
    },

    // —— 人才库（MySQL 异步，连不通自动内存回退；读写独立于决策库，绝不进基础评分）——
    'GET /api/v1/talent/status': async (req, res, cid) => {
      try { json(res, 200, { ...(await talentBackendStatus()), supply_enabled: talentSupplyEnabled() }); }
      catch (e) { err(res, 502, 'TALENT_BACKEND_ERROR', String(e.message).slice(0, 200)); }
    },
    // 人才库健康自检：后端类型 + RDS 连通性 + 建表状态（凭据只出 host/库名，不出密码）。
    // 填完 .env 的 BRAINX_MYSQL_* 后请求此路由即可确认是否真的切到了阿里云 RDS。
    'GET /api/v1/talent/health': async (req, res, cid) => {
      try { json(res, 200, await talentHealth()); }
      catch (e) { err(res, 502, 'TALENT_HEALTH_ERROR', String(e.message).slice(0, 200)); }
    },
    'GET /api/v1/talent': async (req, res, cid, q) => {
      try {
        const items = await listTalentsRepo({
          limit: q.get('limit'), offset: q.get('offset'), status: q.get('status') || null });
        json(res, 200, { items });
      } catch (e) { err(res, 502, 'TALENT_LIST_FAILED', String(e.message).slice(0, 200)); }
    },
    'GET /api/v1/talent/:id': async (req, res, cid, q, id) => {
      try {
        const t = await getTalent(id);
        if (!t) return err(res, 404, 'NOT_FOUND', '候选人不存在');
        json(res, 200, t);
      } catch (e) { err(res, 502, 'TALENT_GET_FAILED', String(e.message).slice(0, 200)); }
    },
    'POST /api/v1/talent/sync': async (req, res, cid) => {
      const b = await body(req);
      const csvPath = b?.csv_path
        ? join(ROOT, b.csv_path)
        : join(ROOT, '公司岗位情况-Shanon - Sheet1.csv');
      if (!isPathInside(ROOT, normalize(csvPath)) || !existsSync(csvPath))
        return err(res, 422, 'BAD_CSV', 'CSV 路径不合法或不存在');
      try {
        const out = await syncTalentsFromCsv(csvPath, { createdBy: null });
        json(res, 200, out);
      } catch (e) { err(res, 502, 'TALENT_SYNC_FAILED', String(e.message).slice(0, 300)); }
    },
    // 简历解析 → 真实候选人入库（单份纯文本；PDF/docx 先由前端转文本再传）
    'POST /api/v1/talent/resume': async (req, res, cid) => {
      const b = await body(req);
      const text = b?.text;
      if (!text || !String(text).trim()) return err(res, 422, 'EMPTY_RESUME', '简历内容为空');
      try {
        const out = await ingestResume(String(text), { fileName: b?.file_name || '', createdBy: null });
        json(res, 200, out);
      } catch (e) { err(res, 502, 'RESUME_INGEST_FAILED', String(e.message).slice(0, 300)); }
    },
    // 批量简历同步：resumes = [{ text, file_name }]
    'POST /api/v1/talent/resumes': async (req, res, cid) => {
      const b = await body(req);
      const resumes = Array.isArray(b?.resumes) ? b.resumes.map((r) => ({ text: r.text, fileName: r.file_name })) : [];
      if (!resumes.length) return err(res, 422, 'NO_RESUMES', '未提供简历');
      try {
        const out = await syncTalentsFromResumes(resumes, { createdBy: null });
        json(res, 200, out);
      } catch (e) { err(res, 502, 'RESUMES_SYNC_FAILED', String(e.message).slice(0, 300)); }
    },
    'GET /api/v1/talent/:id/resumes': async (req, res, cid, q, id) => {
      try { json(res, 200, { items: await listResumes(id) }); }
      catch (e) { err(res, 502, 'RESUME_LIST_FAILED', String(e.message).slice(0, 200)); }
    },
    // 职位供给参考（旁路适配层；BRAINX_TALENT_SUPPLY=1 才启用）
    'GET /api/v1/opportunities/:id/talent-supply': async (req, res, cid, q, id) => {
      const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(id);
      if (!job || !jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      try {
        const snap = await talentSupplyForJob({ project_id: job.project_id, company: job.company, role: job.role, notes: job.notes });
        json(res, 200, snap);
      } catch (e) { err(res, 502, 'TALENT_SUPPLY_FAILED', String(e.message).slice(0, 200)); }
    },
    // —— /login：OAuth 回调失败回跳页（后端直出静态页，不依赖前端路由——前端 SPA fallback 会白屏）——
    'GET /login': (req, res, cid, q) => {
      const msgs = {
        bad_state: '登录状态校验失败（页面打开太久或重复回调），请重新扫码。',
        no_code: '飞书没有返回授权码，请重新扫码。',
        exchange_failed: '授权码换令牌失败（App Secret 配置或网络问题），请稍后重试。',
        not_in_roster: '你的飞书账号不在顾问花名册内——请联系管理员加入 roster。',
      };
      const code = q.get('error') || '';
      const msg = code ? (msgs[code] || '登录过程出现未知错误，请重试。') : '';
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/><title>Brain X · 顾问登录</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;font-family:Inter,'PingFang SC',system-ui,sans-serif">
<div style="width:min(420px,calc(100% - 32px));padding:36px 32px;border-radius:22px;background:#fff;border:1px solid rgba(31,49,83,.12);box-shadow:0 18px 60px rgba(28,42,73,.08)">
<p style="margin:0 0 8px;color:#176B58;font-size:12px;font-weight:700;letter-spacing:.14em">BRAIN X · 顾问登录</p>
<h1 style="margin:0 0 12px;font-size:26px;letter-spacing:-.03em;color:#172034">飞书扫码登录工作台</h1>
<p style="margin:0 0 22px;color:#6c768c;font-size:13px;line-height:1.7">使用你的飞书账号扫码授权。登录后可查看你有权限的职位推荐、承接状态与 OpenMai 自动找人结果。</p>
${msg ? `<div style="margin:0 0 18px;padding:12px 14px;border-radius:12px;border:1px solid rgba(198,75,89,.18);background:rgba(198,75,89,.07);color:#c64b59;font-size:13px;line-height:1.6"><b>登录未成功：</b>${msg}</div>` : ''}
<a href="/api/v1/oauth/authorize" style="display:block;text-decoration:none;text-align:center;border:0;border-radius:12px;padding:13px 16px;background:#176B58;color:#fff;font-size:14px;font-weight:700">飞书扫码 / 授权登录</a>
<p style="margin:16px 0 0;text-align:center"><a href="/" style="color:#6c768c;font-size:13px;text-decoration:none">先看看演示模式 →</a></p>
</div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    },

    // —— 飞书 OAuth 网页授权（多顾问登录的唯一正式入口）——
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
    'GET /api/v1/oauth/callback': async (req, res, cid, q) => {
      const fail = (code) => { res.writeHead(302, { Location: `/login?error=${code}` }); res.end(); };
      if (!verifyState(q.get('state'))) return fail('bad_state');
      const code = q.get('code');
      if (!code) return fail('no_code');
      let identity;
      try { identity = await exchange(code); }
      catch (e) { return fail('exchange_failed'); }
      const consultant = findByOpenId(db, identity.open_id);
      if (!consultant) return fail('not_in_roster'); // fail-closed：不在花名册 = 不是顾问
      // 按人桥接的凭据：把这次授权拿到的用户令牌对加密入库（失败不阻断登录，
      // 只是该顾问暂不能按人拉消息，下轮 sync_error 提醒重登）
      try { saveUserTokens(db, consultant.consultant_id, identity.open_id, identity.tokens); }
      catch (e) { console.error(`[oauth] 令牌入库失败 cid=${consultant.consultant_id}：${String(e.message).slice(0, 80)}`); }
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `brainx_session=${encodeURIComponent(signSession(consultant.consultant_id, identity.open_id))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
      });
      res.end();
    },
    // 开发者后门：仅 BRAINX_DEV_AUTH=1 时可用（离线演示），默认关闭
    'POST /api/v1/session': async (req, res) => {
      if (!devAuth) return err(res, 403, 'DEV_AUTH_OFF', '请使用飞书账号登录');
      const b = await body(req);
      const ok = loadConsultants(db).some((c) => c.consultant_id === b?.consultant_id);
      if (!ok) return err(res, 422, 'UNKNOWN_CONSULTANT', '未知顾问身份');
      res.writeHead(204, { 'Set-Cookie': `brainx_session=${encodeURIComponent(signSession(b.consultant_id))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800` });
      res.end();
    },
    'DELETE /api/v1/session': (req, res) => {
      res.writeHead(204, { 'Set-Cookie': 'brainx_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      res.end();
    },

    'GET /api/v1/workbench': (req, res, cid) => {
      const sync = latestRealSync(db, cid);
      const bridgeErr = latestBridgeError(db, cid, sync?.completed_at || '');
      const run = latestRun(db, cid, { hideEngaged: true });
      const c = commitmentSummary(db, cid);
      json(res, 200, {
        consultant_id: cid,
        sync: sync ? { state: sync.complete ? 'READY' : 'INCOMPLETE', updated_at: sync.completed_at,
                       rows_read: sync.rows_read, rows_expected: sync.rows_expected, errors: JSON.parse(sync.errors || '[]'),
                       warning: bridgeErr ? { at: bridgeErr.started_at, ...friendlyBridgeError(bridgeErr.errors) } : null }
                   : { state: 'EMPTY', updated_at: null },
        feishu_auth: tokenStatus(db, cid), // {authorized, needs_reauth}——头胶囊提示重登
        ttc_auth: ttcAuthStatus(db, cid),  // TTC 系统托管状态（连接胶囊；绝不出 JWT 本体）
        current_policy_version: run?.run?.policy_version || null,
        watched_count: c.watched_count, watched_limit: c.watched_limit,
        accepted_count: c.accepted_count, cooldown_count: 0,
        need_action_count: c.need_action_count, commitments: c.items,
        today_top3: run ? run.items.slice(0, 3) : [],
        run_id: run?.run?.run_id || null,
      });
    },
    'GET /api/v1/workbench/preferences': (req, res, cid) => {
      const row = db.prepare('SELECT tray_json, folders_json, folder_mode, updated_at FROM workbench_preferences WHERE consultant_id=?').get(cid);
      json(res, 200, row ? {
        tray: safeJsonArray(row.tray_json),
        folders: safeJsonArray(row.folders_json),
        folderMode: !!row.folder_mode,
        updatedAt: row.updated_at,
      } : { tray: [], folders: [], folderMode: false, updatedAt: null });
    },

    'PUT /api/v1/workbench/preferences': async (req, res, cid) => {
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const prefs = normalizeWorkbenchPreferences(b);
      const updatedAt = new Date().toISOString();
      db.prepare(`INSERT INTO workbench_preferences (consultant_id, tray_json, folders_json, folder_mode, updated_at)
        VALUES (?,?,?,?,?)
        ON CONFLICT(consultant_id) DO UPDATE SET
          tray_json=excluded.tray_json,
          folders_json=excluded.folders_json,
          folder_mode=excluded.folder_mode,
          updated_at=excluded.updated_at`).run(
        cid, JSON.stringify(prefs.tray), JSON.stringify(prefs.folders), prefs.folderMode ? 1 : 0, updatedAt,
      );
      json(res, 200, { ok: true, ...prefs, updatedAt });
    },
    'GET /api/v1/recommendations': (req, res, cid, q) => {
      const out = recommendationPage(db, cid, { cursor: q.get('cursor'), search: q.get('q'), sort: q.get('sort') });
      if (out.ok === false) return err(res, out.status, out.code, out.message);
      json(res, 200, out);
    },

    'GET /api/v1/recommendations/pick-tray': (req, res, cid, q) => {
      const out = pickTray(db, cid, { limit: q.get('limit'), cursor: q.get('cursor') });
      json(res, 200, out);
    },
    'POST /api/v1/recommendations/feedback': async (req, res, cid) => {
      const out = recommendationFeedback(db, cid, await body(req));
      json(res, out.ok ? 200 : out.status || 422, out);
    },
    'POST /api/v1/recommendations/feedback/undo': async (req, res, cid) => {
      const out = recommendationUndoFeedback(db, cid, await body(req));
      json(res, out.ok ? 200 : out.status || 422, out);
    },
    // 一键反馈（F2，2026-08-24）：推送卡片按钮直写，HMAC 签名代替 session
    // （open 路由，鉴权全在 verifyQuick）。顾问不登录工作台也能产标签。
    'GET /api/v1/feedback/quick': (req, res, cid, q) => {
      const p = Object.fromEntries(q);
      const page = (okFlag, text, status) => {
        res.writeHead(okFlag ? 200 : (status || 400), { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(quickResultPage(okFlag, text));
      };
      const v = verifyQuick(p, now());
      if (!v.ok) return page(false, v.error, v.status);
      const out = p.action === 'watch'
        ? engage(db, p.consultant, p.project, 'WATCH',
                 { idempotency_key: `quick-watch:${p.consultant}:${p.project}:${p.day}` })
        : recommendationFeedback(db, p.consultant,
                 { project_id: p.project, feedback: 'NOT_INTERESTED', reason: '一键反馈（推送卡片）',
                   idempotency_key: `quick-ni:${p.consultant}:${p.project}:${p.day}` });
      if (!out.ok) return page(false, out.error || out.message || '操作失败');
      return page(true, `已记录：${QUICK_ACTIONS[p.action]}${out.already ? '（此前已记录）' : ''}`);
    },
    'POST /api/v1/recommendations/next-batch': async (req, res, cid) => {
      const out = nextBatch(db, cid, await body(req));
      json(res, out.ok ? 200 : out.status || 409, out);
    },

    'POST /api/v1/recommendations/run': (req, res, cid) => {
      const out = recommend(db, cid, { top: 20 });
      json(res, out.blocked ? 409 : 200, out);
    },

    'POST /api/v1/sync-runs': async (req, res, cid) => {
      const b = await body(req);
      try {
        const out = runSync(db, { source: b?.source || 'fixture', consultant_id: cid, dry_run: !!b?.dry_run });
        json(res, 200, out);
      } catch (e) { err(res, 502, 'SYNC_FAILED', String(e.message).slice(0, 300)); }
    },

    'GET /api/v1/sync-runs/:id': (req, res, cid, q, id) => {
      const r = db.prepare('SELECT * FROM sync_runs WHERE sync_id=? AND consultant_id=?').get(id, cid);
      if (!r) return err(res, 404, 'NOT_FOUND', '同步批次不存在');
      json(res, 200, { ...r, errors: JSON.parse(r.errors || '[]'),
        field_report: ttcFieldReportForSync(db, cid, id) });
    },

    'GET /api/v1/opportunities/:id': (req, res, cid, q, id) => {
      const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(id);
      // fail-closed：与自己无任何关系的职位一律 404（不泄露存在性），事实明细不出库
      if (!job || !jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const effective = effectiveJob(db, cid, id);
      const relRow = db.prepare(`SELECT relation, source, valid_from FROM job_memberships
        WHERE project_id=? AND consultant_id=? AND valid_to IS NULL`).get(id, cid);
      const rel = relationOf(db, cid, id); // 推导关系单一权威（relations.js）
      const eng = currentState(db, cid, id);
      const events = [
        ...db.prepare(`SELECT event_type, occurred_at, actor, reason FROM decision_events
          WHERE project_id=? AND actor=? ORDER BY occurred_at, id`).all(id, cid),
        ...db.prepare(`SELECT 'FACT_UPDATED' AS event_type, occurred_at, consultant_id AS actor,
          '人工修正项目事实并重新判断' AS reason FROM fact_override_events
          WHERE project_id=? AND consultant_id=? ORDER BY occurred_at, id`).all(id, cid),
      ].sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
      const rec = db.prepare(`SELECT * FROM recommendations WHERE project_id=? AND consultant_id=?
        ORDER BY created_at DESC LIMIT 1`).get(id, cid);
      const outs = db.prepare(`SELECT stage, value_json, observed_at, action_id, kind FROM job_outcomes
        WHERE project_id=? AND consultant_id=? ORDER BY observed_at`).all(id, cid);
      // 接单自动找人（0015）：本人接单过才带出状态/结果，其余 null（fail-closed，不泄露存在性）
      const openmai = ['ACCEPTED', 'COMPLETED'].includes(eng.state) ? getOpenmaiResult(db, cid, id) : null;
      json(res, 200, {
        job: { ...effective, raw_json: undefined, relation: rel },
        fact_updates: effectiveFactPayload(db, cid, id),
        relation: { relation: rel, source: relRow?.source || null, valid_from: relRow?.valid_from || null },
        engagement_state: eng.state, legal_actions: legalActions(db, cid, id).filter((action) => action !== 'COMPLETE'),
        events, outcomes: outs.map((o) => ({ ...o, value: JSON.parse(o.value_json) })),
        ...commitmentDetails(db, cid, id),
        openmai,
        latest_recommendation: rec ? { decision_id: rec.decision_id, score: rec.score,
          action: rec.action, confidence_band: rec.confidence_band,
          evidence_coverage: rec.evidence_coverage,
          reasons: JSON.parse(rec.reasons_json), risks: JSON.parse(rec.risks_json),
          evidence_refs: JSON.parse(rec.evidence_refs_json),
          breakdown: JSON.parse(rec.breakdown_json), policy_version: rec.policy_version, created_at: rec.created_at } : null,
      });
    },

    'PATCH /api/v1/opportunities/:id/facts': async (req, res, cid, q, id) => {
      const job = db.prepare('SELECT 1 FROM job_facts WHERE project_id=?').get(id);
      if (!job || !jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      try {
        const out = updateFactOverrides(db, cid, id, b);
        if (!out.ok) return err(res, out.status || 422, 'FACT_UPDATE_REJECTED', out.error);
        // 覆盖写入后生成新冻结推荐；旧 run / replay 行永不更新。
        const rec = out.already ? null : recommend(db, cid, { top: 20 });
        const latest = latestRun(db, cid);
        const item = latest?.items.find((r) => r.job?.project_id === id) || null;
        json(res, rec?.blocked ? 409 : 200, {
          ok: true, already: !!out.already, event_id: out.event_id,
          effective: effectiveJob(db, cid, id), fact_updates: effectiveFactPayload(db, cid, id),
          recommendation: item ? {
            decision_id: item.decision_id, run_id: latest.run.run_id, action: item.action,
            score: item.score, breakdown: item.breakdown, reasons: item.reasons,
            risks: item.risks, evidence_coverage: item.evidence_coverage,
          } : null,
          decision_run_id: latest?.run?.run_id || rec?.run_id || null,
          recompute: rec?.blocked ? { blocked: true, reason: rec.reason } : { blocked: false },
        });
      } catch (e) { err(res, 500, 'FACT_UPDATE_FAILED', String(e.message).slice(0, 300)); }
    },

    'POST /api/v1/opportunities/:id/engagement': async (req, res, cid, q, id) => {
      if (!jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      if (b.action === 'COMPLETE') return err(res, 422, 'TERMINAL_RESULT_REQUIRED', '请通过终局结果接口提交入职或关闭');
      const out = b.action === 'ACCEPT' ? acceptCommitment(db, cid, id, b)
        : b.action === 'RELEASE' ? releaseCommitment(db, cid, id, b)
        : engage(db, cid, id, b.action, b);
      // 接单自动触发 OpenMai 找人（接单 → 异步找人 → SSE 定向回传；防重/费用控制在任务模块内）
      if (out.ok && out.state === 'ACCEPTED' && b?.action === 'ACCEPT') {
        try { out.openmai = startOpenmaiTask(db, bus, cid, id); }
        catch (e) { out.openmai = { status: 'error', message: String(e.message).slice(0, 200) }; }
      }
      json(res, out.ok ? 200 : (out.status || 409), out);
    },

    'POST /api/v1/opportunities/:id/progress/suggestion': async (req, res, cid, q, id) => {
      if (!jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      json(res, 200, { ok: true, suggestion: suggestedAction(db, cid, id, b) });
    },

    'POST /api/v1/opportunities/:id/progress': async (req, res, cid, q, id) => {
      if (!jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const out = recordProgress(db, cid, id, b);
      json(res, out.ok ? 200 : (out.status || 422), out);
    },

    'POST /api/v1/opportunities/:id/terminal-result': async (req, res, cid, q, id) => {
      if (!jobVisibleTo(db, cid, id)) return err(res, 404, 'NOT_FOUND', '职位不存在');
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const out = recordTerminalResult(db, cid, id, b);
      json(res, out.ok ? 200 : (out.status || 422), out);
    },

    // —— 接单自动找人：状态/结果查询（fail-closed：只许本人接单过的职位）——
    'GET /api/v1/opportunities/:id/openmai': (req, res, cid, q, id) => {
      const st = currentState(db, cid, id)?.state;
      if (!['ACCEPTED', 'COMPLETED'].includes(st)) return err(res, 404, 'NOT_FOUND', '职位不存在或未接单');
      json(res, 200, getOpenmaiResult(db, cid, id));
    },
    // 显式重新找人（防重复费用：running 拒绝；done/failed 才可重跑）
    'POST /api/v1/opportunities/:id/openmai/rerun': (req, res, cid, q, id) => {
      const st = currentState(db, cid, id)?.state;
      if (!['ACCEPTED', 'COMPLETED'].includes(st)) return err(res, 404, 'NOT_FOUND', '职位不存在或未接单');
      const cur = getOpenmaiResult(db, cid, id);
      const staleMs = Date.now() - Date.parse(cur.started_at || 0); // 超 60min 视为僵死放行（曾永久 409）
      if (cur.status === 'running' && !(Number.isFinite(staleMs) && staleMs > 60 * 60 * 1000)) return err(res, 409, 'RUNNING', '找人在进行中，请等待完成后再试');
      const out = startOpenmaiTask(db, bus, cid, id, { force: true });
      json(res, 200, { ok: true, openmai: out });
    },

    'GET /api/v1/decisions/:id/replay': (req, res, cid, q, id) => {
      // 回放只能看自己名下的推荐（冻结行含评分理由，跨人泄露 = 泄露他人决策上下文）
      const owner = db.prepare('SELECT consultant_id FROM recommendations WHERE decision_id=?').get(id);
      if (!owner || owner.consultant_id !== cid) return err(res, 404, 'NOT_FOUND', '决策不存在');
      const r = replay(db, id);
      if (!r) return err(res, 404, 'NOT_FOUND', '决策不存在');
      json(res, 200, r);
    },

    'POST /api/v1/outcomes': async (req, res, cid) => {
      const b = await body(req);
      if (!b?.project_id || !b?.stage) return err(res, 400, 'BAD_REQUEST', '缺 project_id/stage');
      const out = recordOutcome(db, cid, b);
      json(res, out.ok ? 200 : (out.status || 400), out);
    },

    'GET /api/v1/dismiss-reasons': (req, res) => json(res, 200, { items: DISMISS_REASONS }),
    'GET /api/v1/commitment-options': (req, res) => json(res, 200, {
      release_reasons: RELEASE_REASONS, close_reasons: CLOSE_REASONS,
    }),

    // 职位雷达与客户洞察（fail-closed 可见性；只呈现事实，不补造运营指标）
    'GET /api/v1/radar': (req, res, cid) => json(res, 200, radarPayload(db, cid)),
    'GET /api/v1/clients': (req, res, cid) => json(res, 200, { items: clientRows(db, cid) }),
    ...ttcRoutes(db),

    // 我的档案（方向画像）：只许读/改自己；保存后下一轮 recommend 即生效
    'GET /api/v1/profile': (req, res, cid) => {
      const c = loadConsultants(db).find((x) => x.consultant_id === cid);
      json(res, 200, { consultant_id: cid, display_name: c?.display_name || cid,
        profile_keywords: c?.profile_keywords || [], profile_note: c?.profile_note || '',
        weights: c?.weights || null,
        feishu_auth: tokenStatus(db, cid) });
    },
    'PUT /api/v1/profile': async (req, res, cid) => {
      const b = await body(req);
      if (!b) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const out = updateProfile(db, cid, b);
      json(res, out.ok ? 200 : (out.status || 400), out);
    },

    // 职位快照（外部系统消费，替代直打 CRM job/search；API Key 鉴权，不走 session）
    'GET /api/v1/jobs/snapshot': (req, res, cid, q) => {
      if (!verifySnapshotKey(req)) return err(res, 401, 'INVALID_API_KEY', '缺少或无效的 API Key（Bearer token）');
      const out = jobSnapshot(db, {
        updated_after: q.get('updated_after') || undefined,
        updated_before: q.get('updated_before') || undefined,
        status: q.get('status') || undefined,
        limit: q.get('limit') || undefined,
      });
      json(res, 200, out);
    },

    // 请求指标（预测告警装置数据源）：聚合计数/字节量，无敏感数据，供看门狗轮询
    'GET /api/v1/meta/guard': (req, res) => json(res, 200, guard.snapshot()),

    // 浏览器端错误上报（白屏/资源 404/水合失败特征源）：实现在 client-error.js
    'POST /api/v1/meta/client-error': makeClientErrorRoute(guard),

    // SSE：桥接器有变化时推 sync/recommend/sync_error；25s 心跳保活
    'GET /api/v1/events': (req, res, cid) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
                           'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', consultant_id: cid,
        at: new Date().toISOString() })}\n\n`);
      sseClients.set(res, cid);
      const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closed */ } }, 25000);
      req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    },

    'POST /api/v1/push/preview': (req, res, cid) => {
      const sync = latestRealSync(db, cid);
      const snapshot = latestCompleteSnapshot(db, cid);
      const run = latestRun(db, cid, { hideEngaged: true });
      const c = commitmentSummary(db, cid);
      const name = loadConsultants(db).find((x) => x.consultant_id === cid)?.display_name || cid;
      const card = sync && !sync.complete
        ? buildSyncAlertCard(sync)
        : buildDailyCard({ consultant_name: name, consultant_id: cid, run: run?.run, items: run?.items || [],
                           commitments: c, sync, snapshot_id: snapshot?.sync_id });
      json(res, 200, { card });
    },

    'POST /api/v1/push/send': async (req, res, cid) => {
      const b = await body(req);
      const sync = latestRealSync(db, cid);
      const snapshot = latestCompleteSnapshot(db, cid);
      const run = latestRun(db, cid, { hideEngaged: true });
      const c = commitmentSummary(db, cid);
      const name = loadConsultants(db).find((x) => x.consultant_id === cid)?.display_name || cid;
      const kind = sync && !sync.complete ? 'SYNC_ALERT' : 'DAILY_TOP3';
      const card = kind === 'SYNC_ALERT'
        ? buildSyncAlertCard(sync)
        : buildDailyCard({ consultant_name: name, consultant_id: cid, run: run?.run, items: run?.items || [],
                           commitments: c, sync, snapshot_id: snapshot?.sync_id });
      const target = b?.target || process.env.BRAINX_PUSH_TARGET || '';
      if (!target) return err(res, 400, 'NO_TARGET', '缺推送目标（chat_id/open_id 或 BRAINX_PUSH_TARGET）');
      const out = await pushCard(db, { consultant_id: cid, kind, run_id: run?.run?.run_id || null,
                                 card, target, send: true });
      json(res, out.ok ? 200 : 502, out);
    },
  };

  const server = http.createServer(async (req, res) => {
    guard.record(req, res);
    const u = new URL(req.url, 'http://x');
    let path = u.pathname;
    // 动态段匹配：/api/v1/opportunities/:id/engagement 等
    let handler = routes[`${req.method} ${path}`];
    let dynId = null;
    if (!handler) {
      for (const key of Object.keys(routes)) {
        const [m, p] = key.split(' ');
        if (m !== req.method || !p.includes(':id')) continue;
        const rx = new RegExp('^' + p.replace(':id', '([^/]+)') + '$');
        const mm = rx.exec(path);
        if (mm) { handler = routes[key]; dynId = decodeURIComponent(mm[1]); break; }
      }
    }
    if (handler) {
      const open = ['GET /api/v1/consultants', 'POST /api/v1/session', 'DELETE /api/v1/session',
                    'GET /api/v1/oauth/status', 'GET /api/v1/oauth/authorize', 'GET /api/v1/oauth/callback',
                    'GET /login',
                    // 扩展自动同步 TTC JWT：免登录（扩展无 brainx session），凭来源校验 + JWT 活验证兜底
                    'POST /api/v1/ttc/ext-sync', 'GET /api/v1/ttc/status',
                    // 人才库健康探测：纯状态（后端类型/连通性/建表），不含任何用户数据或密码，
                    // 允许未登录访问，以便数据源页无论登录与否都能显示真库连接状态。
                    'GET /api/v1/talent/health', 'GET /api/v1/talent/status',
                    // 职位快照：外部系统（York AI worker 等）无 brainx session，凭 API Key 读取；
                    // 鉴权在 handler 内自校验（verifySnapshotKey），未配置 key 时 fail-closed 全拒。
                    'GET /api/v1/jobs/snapshot', 'GET /api/v1/meta/guard',
                    'POST /api/v1/meta/client-error', // 浏览器端错误探针：未必有 session，只写聚合日志
                    // 一键反馈：无 session，HMAC 签名即鉴权（verifyQuick fail-closed）
                    'GET /api/v1/feedback/quick'];
      const cid = open.includes(`${req.method} ${path}`) ? null : auth(req, res);
      if (open.includes(`${req.method} ${path}`) || cid) {
        try { return await handler(req, res, cid, u.searchParams, dynId); }
        catch (e) { return err(res, 500, 'INTERNAL', String(e.message).slice(0, 300)); }
      }
      return;
    }
    // —— 本地静态资源直读：vinext Windows 下不提供 /assets，从 dist/client 直接返回 ——
    if (!path.startsWith('/api/') && STATIC_DIR && /^\/(assets|favicon\.ico|fonts|images|icons)\b/.test(path)) {
      const rel = path.replace(/^\/+/, '');
      const fp = join(STATIC_DIR, rel);
      if (isPathInside(STATIC_DIR, fp) && existsSync(fp) && statSync(fp).isFile()) {
        const ct = STATIC_MIME[extname(fp).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
        res.end(readFileSync(fp));
        return;
      }
    }
    if (deps.frontendTarget && !path.startsWith('/api/')) {
      return proxyFrontend(req, res, deps.frontendTarget);
    }
    // 单一前端：非 API 请求由 btex-frontend 代理；未启用前端时直接 404
    err(res, 404, 'NOT_FOUND', `${req.method} ${path}`);
  });
  server.bus = bus; // 主块/测试用来广播桥接事件
  server.guard = guard; // 看门狗/测试可直读指标
  server.frontendTarget = deps.frontendTarget || null;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.BRAINX_PORT || 3000);
  // 只绑回环：工作台含未脱敏业务数据，不应对局域网暴露（BRAINX_HOST 显式覆盖除外）
  const host = process.env.BRAINX_HOST || '127.0.0.1';
  const db = openDb();
  const frontendTarget = process.env.BRAINX_FRONTEND_OFF === '1'
    ? null
    : { host: FRONTEND_HOST, port: FRONTEND_PORT };
  const server = createServer(db, { frontendTarget });
  let frontendProcess = null;
  if (frontendTarget && existsSync(join(FRONTEND_DIR, 'package.json'))) {
    // Windows 上 npm 实为 npm.cmd，spawn 默认不带 shell 且不补 .cmd 后缀，直接 spawn('npm') 会 ENOENT
    const isWin = process.platform === 'win32';
    frontendProcess = spawn(isWin ? 'npm.cmd' : 'npm', ['run', 'start', '--', '--host', FRONTEND_HOST, '--port', String(FRONTEND_PORT)], {
      cwd: FRONTEND_DIR,
      env: { ...process.env, PORT: String(FRONTEND_PORT), HOSTNAME: FRONTEND_HOST },
      shell: isWin,
      stdio: 'inherit',
    });
    frontendProcess.on('error', (e) => console.error(`[frontend] 启动失败：${e.message}`));
    frontendProcess.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') console.error(`[frontend] 已退出 code=${code} signal=${signal || '-'}`);
    });
    console.log(`前端服务: http://${FRONTEND_HOST}:${FRONTEND_PORT}（由 Brain X 代理）`);
  } else if (frontendTarget) {
    console.error(`[frontend] 未找到 ${FRONTEND_DIR}，请安装前端依赖：cd frontend/btex-frontend && npm install && npm run build`);
  }
  const shutdown = () => {
    if (frontendProcess && !frontendProcess.killed) frontendProcess.kill('SIGTERM');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(port, host, () => console.log(`Brain X 工作台: http://${host}:${port}`));
  // 桥接常驻：BRAINX_BRIDGE_INTERVAL_MS（默认 180s）；BRAINX_BRIDGE_OFF=1 关闭
  if (process.env.BRAINX_BRIDGE_OFF !== '1') {
    startBridge(db, server.bus, {
      recommendFn: (cid) => recommend(db, cid, { top: 20, throttle: true }), // 方案 A：自动轮次快照未变<2h 跳过冻结
      consultantIdsFn: () => loadConsultants(db).map((c) => c.consultant_id),
      onRecommended: makeAutoPush(db), // 重大变化自动推卡；BRAINX_PUSH_AUTO=1 才真发
    });
    console.log(`桥接器已启动（间隔 ${Number(process.env.BRAINX_BRIDGE_INTERVAL_MS || 180000) / 1000}s）`);
  }
  // 定时推送：每天 07:00 / 19:00（CST）给每位顾问发 Top3 卡；BRAINX_PUSH_SCHEDULE=0 关闭
  startScheduler(db);
  console.log('定时推送已启动（07:00 / 19:00 CST）');
}
