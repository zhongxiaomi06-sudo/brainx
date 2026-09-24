/** server.js — HTTP API + 静态工作台（补全文档 §16 契约）。
 * 零框架 node:http。除 session/consultants/oauth 外全部要登录 Cookie。
 */
import './env.js';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now } from './db.js';
import { runSync, latestSync, latestRealSync, latestBridgeError, latestCompleteSnapshot, friendlyBridgeError } from './sync.js';
import { createRecommendationUseCase } from './recommendation-use-case.js';
import { engage, commitmentSummary, currentState, legalActions } from './engagement.js';
import { replay, recordOutcome } from './replay.js';
import { acceptCommitment, commitmentDetails, recordProgress, recordTerminalResult,
  releaseCommitment, suggestedAction, RELEASE_REASONS, CLOSE_REASONS } from './commitment.js';
import { buildAgenticDailyCard, buildDailyCard, buildSyncAlertCard, pushCard, syncAlertKey } from './push.js';
import { agenticRecommendationPage } from './agentic-ranking/presentation.js';
import { verifySession, cookieOf } from './session.js';
import { updateProfile } from './roster.js';
import { startWorkerTasks } from './worker.js';
import { startRelayPump } from './worker-relay.js';
import { tokenStatus } from './feishu.js';
import { jobVisibleTo } from './visibility.js';
import { relationOf } from './relations.js';
import { projectRoutes } from './project-routes.js';
import { postAcceptSideEffects } from './accept-launch.js';
import { getOpenmaiResult } from './openmai-task.js';
import { openmaiRoutes } from './openmai-routes.js';
import { radarPayload, clientRows } from './radar.js';
import { ttcFieldReportForSync } from './ttc-field-report.js';
import { ttcAuthStatus, ttcRoutes } from './ttc-routes.js';
import { effectiveJob, effectiveFactPayload, updateFactOverrides } from './facts.js';
import { assistantRoutes } from './assistant-routes.js';
import { personalModelRoutes } from './personal-model-routes.js';
import { recommendationRoutes } from './recommendation-routes.js';
import { verifySnapshotKey, jobSnapshot } from './snapshot.js';
import { createGuard } from './guard.js';
import { makeClientErrorRoute } from './client-error.js';
import { authRoutes } from './auth-routes.js';
import { talentRoutes } from './talent-routes.js';
import { body, err, isPathInside, json, normalizeWorkbenchPreferences, proxyFrontend,
  resolveRoute, safeJsonArray, STATIC_MIME } from './server-http.js';
export { isPathInside } from './server-http.js';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND_DIR = join(ROOT, 'frontend', 'btex-frontend');
const FRONTEND_HOST = process.env.BRAINX_FRONTEND_HOST || '127.0.0.1';
const FRONTEND_PORT = Number(process.env.BRAINX_FRONTEND_PORT || 4321);
// 本地静态资源目录：vinext 在部分环境（Windows）不提供 /assets，后端直接读 dist 产物绕过
const STATIC_DIR = join(FRONTEND_DIR, 'dist', 'client');
export function createServer(db = openDb(), deps = {}) {
  const recommendations = deps.recommendations || createRecommendationUseCase(db);
  const agenticReadEnabled = deps.agenticReadEnabled ?? process.env.BRAINX_AGENTIC_READ === '1';
  const delivery = (cid) => agenticReadEnabled
    ? agenticRecommendationPage(db, cid) : recommendations.latest(cid, { hideEngaged: true });
  const dailyCard = (cid, name, run, commitments, sync, snapshotId) => agenticReadEnabled
    ? buildAgenticDailyCard({ consultant_name: name, run, items: run?.items || [], commitments })
    : buildDailyCard({ consultant_name: name, consultant_id: cid, run: run?.run,
      items: run?.items || [], commitments, sync, snapshot_id: snapshotId });
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
    ...projectRoutes(db, { ...(deps.projectLaunch || {}), bus }),
    ...personalModelRoutes(db, deps),
    ...openmaiRoutes(db, bus),
    ...authRoutes(db, { exchangeCode: deps.exchangeCode }),
    ...talentRoutes(db, { rootDir: ROOT }),
    ...recommendationRoutes(db, { recommendations, bus, projectLaunch: deps.projectLaunch,
      agenticReadEnabled }),
    'GET /api/v1/consultants': (req, res) => {
      json(res, 200, { items: recommendations.consultants()
        .map((c) => ({ consultant_id: c.consultant_id, display_name: c.display_name })) });
    },

    'GET /api/v1/workbench': (req, res, cid) => {
      const sync = latestRealSync(db, cid);
      const bridgeErr = latestBridgeError(db, cid, sync?.completed_at || '');
      const run = delivery(cid);
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
        const rec = out.already ? null : recommendations.run(cid, { top: 20 });
        const latest = recommendations.latest(cid);
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
      // 接单成功后副作用编排（触发找人 + 接单直接拉群，specs/011）见 accept-launch.js
      await postAcceptSideEffects(db, bus, deps, cid, id, b, out);
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

    // 旧客户端启动兼容：动作已下线，只返回空列表，避免恢复“暂不考虑”语义。
    'GET /api/v1/dismiss-reasons': (req, res) => json(res, 200, { items: [] }),
    'GET /api/v1/commitment-options': (req, res) => json(res, 200, {
      release_reasons: RELEASE_REASONS, close_reasons: CLOSE_REASONS,
    }),

    // 职位雷达与客户洞察（fail-closed 可见性；只呈现事实，不补造运营指标）
    'GET /api/v1/radar': (req, res, cid) => json(res, 200, radarPayload(db, cid)),
    'GET /api/v1/clients': (req, res, cid) => json(res, 200, { items: clientRows(db, cid) }),
    ...ttcRoutes(db),

    // 我的档案（方向画像）：只许读/改自己；保存后下一轮 recommend 即生效
    'GET /api/v1/profile': (req, res, cid) => {
      const c = recommendations.consultants().find((x) => x.consultant_id === cid);
      json(res, 200, { consultant_id: cid, display_name: c?.display_name || cid,
        profile_keywords: c?.profile_keywords || [], profile_note: c?.profile_note || '',
        excluded_companies: c?.excluded_companies || [], excluded_roles: c?.excluded_roles || [],
        excluded_cities: c?.excluded_cities || [], capacity_limit: c?.capacity_limit || null,
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
      const run = recommendations.latest(cid, { hideEngaged: true });
      const c = commitmentSummary(db, cid);
      const name = recommendations.consultants()
        .find((x) => x.consultant_id === cid)?.display_name || cid;
      const card = sync && !sync.complete
        ? buildSyncAlertCard(sync)
        : dailyCard(cid, name, run, c, sync, snapshot?.sync_id);
      json(res, 200, { card });
    },

    'POST /api/v1/push/send': async (req, res, cid) => {
      const b = await body(req);
      const sync = latestRealSync(db, cid);
      const snapshot = latestCompleteSnapshot(db, cid);
      const run = delivery(cid);
      const c = commitmentSummary(db, cid);
      const name = recommendations.consultants()
        .find((x) => x.consultant_id === cid)?.display_name || cid;
      const kind = sync && !sync.complete ? 'SYNC_ALERT' : 'DAILY_TOP3';
      const card = kind === 'SYNC_ALERT'
        ? buildSyncAlertCard(sync)
        : dailyCard(cid, name, run, c, sync, snapshot?.sync_id);
      const target = b?.target || process.env.BRAINX_PUSH_TARGET || '';
      if (!target) return err(res, 400, 'NO_TARGET', '缺推送目标（chat_id/open_id 或 BRAINX_PUSH_TARGET）');
      const rid = kind === 'SYNC_ALERT' ? syncAlertKey() : (run?.run_id || run?.run?.run_id || null);
      const out = await pushCard(db, { consultant_id: cid, kind, run_id: rid, card, target, send: true });
      json(res, out.ok ? 200 : 502, out);
    },
  };

  const server = http.createServer(async (req, res) => {
    guard.record(req, res);
    const u = new URL(req.url, 'http://x');
    let path = u.pathname;
    // 动态段匹配含 H-1 修复：非法百分号编码（如 %zz）由 resolveRoute 收口为 invalidPath
    const { handler, dynId, invalidPath } = resolveRoute(routes, req.method, path);
    if (invalidPath) return err(res, 400, 'INVALID_PATH', '路径段不是合法的百分号编码');
    if (handler) {
      const open = ['GET /api/v1/consultants', 'POST /api/v1/session', 'DELETE /api/v1/session',
                    'GET /api/v1/oauth/status', 'GET /api/v1/oauth/authorize', 'GET /api/v1/oauth/callback',
                    'GET /login',
                    // 扩展自动同步 TTC JWT：免登录，凭来源校验+JWT 活验证+归属一致校验兜底；ttc/status 已收回需登录
                    'POST /api/v1/ttc/ext-sync',
                    // 人才库健康探测：纯状态（后端类型/连通性/建表），不含任何用户数据或密码，
                    // 允许未登录访问，以便数据源页无论登录与否都能显示真库连接状态。
                    'GET /api/v1/talent/health', 'GET /api/v1/talent/status',
                    // 职位快照：外部系统（York AI worker 等）无 brainx session，凭 API Key 读取；
                    // 鉴权在 handler 内自校验（verifySnapshotKey），未配置 key 时 fail-closed 全拒。
                    'GET /api/v1/jobs/snapshot', 'GET /api/v1/meta/guard',
                    'POST /api/v1/meta/client-error', // 浏览器端错误探针：未必有 session，只写聚合日志
                    // 推荐卡一键动作：无 session，HMAC 签名即鉴权（verifyQuick fail-closed）
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
  server.sseClients = sseClients; // shutdown 收尾用
  server.guard = guard; // 看门狗/测试可直读指标
  server.frontendTarget = deps.frontendTarget || null;
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // H-1 兜底：漏网的 Promise rejection 不接管会让 Node≥15 默认崩溃进程；记录到 stderr、不退出。
  process.on('unhandledRejection', (reason) => console.error('[brainx] unhandledRejection（已兜底）:', reason));
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
    // SSE 恒非 idle 会让 server.close 永等——先结束 SSE，再 closeAllConnections，5s 强退保底
    for (const res of (server.sseClients?.keys() || [])) { try { res.end(); } catch { /* 已断开 */ } }
    server.sseClients?.clear();
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  server.listen(port, host, () => console.log(`Brain X 工作台: http://${host}:${port}`));
  if (process.env.BRAINX_EMBED_WORKER === '0') {
    // 拆分模式：批处理在独立 worker 进程（npm run worker），事件经 worker_events 表泵回 SSE
    startRelayPump(db, server.bus);
    console.log('拆分模式：批处理由独立 worker 进程承担（npm run worker）');
  } else {
    startWorkerTasks(db, server.bus); // 嵌入模式（默认）：行为与拆分前一致
  }
}
