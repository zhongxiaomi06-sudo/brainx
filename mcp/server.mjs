#!/usr/bin/env node
/** brainx-mcp — MCP stdio 服务器（零依赖手写 NDJSON + JSON-RPC 2.0）。
 * Codex CLI / Claude Code / OpenCode 三端注册同一命令：
 *   node /Users/ashley/Downloads/brainx/mcp/server.mjs
 *
 * 直连 src/*.js（不绕 HTTP，web 服务不用在线）。actor=consultant_id 参数归属，
 * 与 braintex-mcp 同一信任模型：本机 agent 代表某顾问行动，事件账本记 actor。
 */
import '../src/env.js';
import { createInterface } from 'node:readline';
import { openDb } from '../src/db.js';
import { runSync, latestSync, latestCompleteSnapshot } from '../src/sync.js';
import { recommend, latestRun, loadConsultants } from '../src/recommend.js';
import { engage, commitmentSummary, currentState, legalActions, DISMISS_REASONS } from '../src/engagement.js';
import { replay, recordOutcome } from '../src/replay.js';
import { acceptCommitment, commitmentDetails, recordProgress, recordTerminalResult,
  releaseCommitment, suggestedAction, RELEASE_REASONS, CLOSE_REASONS } from '../src/commitment.js';
import { buildDailyCard, buildSyncAlertCard } from '../src/push.js';
import { jobVisibleTo } from '../src/visibility.js';
import { relationOf } from '../src/relations.js';
import { updateProfile } from '../src/roster.js';

const db = openDb();

// —— 工具实现（与 server.js 路由同一套领域函数，输出原样 JSON）——
const TOOLS = {
  brainx_consultants: {
    description: '顾问花名册（consultant_id/显示名；open_id 不出 MCP）',
    inputSchema: { type: 'object', properties: {} },
    run: () => loadConsultants(db).map((c) => ({ consultant_id: c.consultant_id, display_name: c.display_name })),
  },
  brainx_workbench: {
    description: '工作台模型：同步状态/承接摘要/今日 Top3（与 Web 首屏同源）',
    inputSchema: { type: 'object', required: ['consultant_id'], properties: {
      consultant_id: { type: 'string' } } },
    run: ({ consultant_id: cid }) => {
      const sync = latestSync(db, cid);
      const run = latestRun(db, cid);
      const c = commitmentSummary(db, cid);
      return {
        consultant_id: cid,
        sync: sync ? { state: sync.complete ? 'READY' : 'INCOMPLETE', updated_at: sync.completed_at,
                       rows_read: sync.rows_read, rows_expected: sync.rows_expected,
                       errors: JSON.parse(sync.errors || '[]') } : { state: 'EMPTY' },
        current_policy_version: run?.run?.policy_version || null,
        watched_count: c.watched_count, watched_limit: c.watched_limit,
        accepted_count: c.accepted_count, need_action_count: c.need_action_count,
        commitments: c.items, today_top3: run ? run.items.slice(0, 3) : [],
        run_id: run?.run?.run_id || null,
      };
    },
  },
  brainx_recommendations: {
    description: '最近一轮推荐（冻结行；同步不完整时 blocked）',
    inputSchema: { type: 'object', required: ['consultant_id'], properties: {
      consultant_id: { type: 'string' }, limit: { type: 'number' } } },
    run: ({ consultant_id: cid, limit = 10 }) => {
      const sync = latestSync(db, cid);
      const run = latestRun(db, cid);
      if (sync && !sync.complete) return { blocked: true, reason: '本次同步不完整，为避免误导，暂不生成正式推荐', items: [] };
      if (!run) return { blocked: false, empty: true, items: [] };
      return { blocked: false, run_id: run.run.run_id, policy_version: run.run.policy_version,
               generated_at: run.run.created_at, items: run.items.slice(0, Math.min(limit, 50)) };
    },
  },
  brainx_recommend_run: {
    description: '生成一轮新推荐（写 recommendations + RECOMMENDED 事件）',
    inputSchema: { type: 'object', required: ['consultant_id'], properties: {
      consultant_id: { type: 'string' }, top: { type: 'number' } } },
    run: ({ consultant_id: cid, top = 10 }) => recommend(db, cid, { top }),
  },
  brainx_opportunity: {
    description: '单个职位全量：事实/关系/承接状态/合法操作/事件/结果/最近推荐',
    inputSchema: { type: 'object', required: ['consultant_id', 'project_id'], properties: {
      consultant_id: { type: 'string' }, project_id: { type: 'string' } } },
    run: ({ consultant_id: cid, project_id: pid }) => {
      const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(pid);
      // 与 HTTP 同一可见性规则（visibility.js 单一权威）：无关系 = NOT_FOUND
      if (!job || !jobVisibleTo(db, cid, pid)) return { error: 'NOT_FOUND', project_id: pid };
      const rel = relationOf(db, cid, pid); // 推导关系单一权威（relations.js）
      const eng = currentState(db, cid, pid);
      const events = db.prepare(`SELECT event_type, occurred_at, actor, reason FROM decision_events
        WHERE project_id=? AND actor=? ORDER BY occurred_at, id`).all(pid, cid);
      const rec = db.prepare(`SELECT * FROM recommendations WHERE project_id=? AND consultant_id=?
        ORDER BY created_at DESC LIMIT 1`).get(pid, cid);
      const outs = db.prepare(`SELECT stage, value_json, observed_at, action_id, kind FROM job_outcomes
        WHERE project_id=? AND consultant_id=? ORDER BY observed_at`).all(pid, cid);
      return {
        job: { ...job, raw_json: undefined, relation: rel }, relation: rel,
        engagement_state: eng.state, legal_actions: legalActions(db, cid, pid).filter((action) => action !== 'COMPLETE'),
        events, outcomes: outs.map((o) => ({ ...o, value: JSON.parse(o.value_json) })),
        ...commitmentDetails(db, cid, pid),
        latest_recommendation: rec ? { decision_id: rec.decision_id, score: rec.score,
          action: rec.action, confidence_band: rec.confidence_band,
          evidence_coverage: rec.evidence_coverage,
          reasons: JSON.parse(rec.reasons_json), risks: JSON.parse(rec.risks_json),
          breakdown: JSON.parse(rec.breakdown_json) } : null,
      };
    },
  },
  brainx_engage: {
    description: '承接操作：接单必须带目标/第一行动/截止时间；释放必须带原因/说明；终局请用 brainx_terminal_result',
    inputSchema: { type: 'object', required: ['consultant_id', 'project_id', 'action'], properties: {
      consultant_id: { type: 'string' }, project_id: { type: 'string' },
      action: { type: 'string', enum: ['VIEW', 'WATCH', 'UNWATCH', 'ACCEPT', 'DISMISS', 'RELEASE'] },
      confirm: { type: 'boolean' }, reason: { type: 'string' }, summary: { type: 'string' },
      goal: { type: 'string' }, action_title: { type: 'string' }, due_at: { type: 'string' },
      idempotency_key: { type: 'string' } } },
    run: ({ consultant_id: cid, project_id: pid, action, ...rest }) => {
      if (!jobVisibleTo(db, cid, pid)) return { error: 'NOT_FOUND', project_id: pid };
      if (action === 'ACCEPT') return acceptCommitment(db, cid, pid, rest);
      if (action === 'RELEASE') return releaseCommitment(db, cid, pid, rest);
      return engage(db, cid, pid, action, rest);
    },
  },
  brainx_progress_suggestion: {
    description: '根据阶段或阻塞状态生成可审计的下一行动草案；只返回建议，不写库',
    inputSchema: { type: 'object', required: ['consultant_id', 'project_id'], properties: {
      consultant_id: { type: 'string' }, project_id: { type: 'string' },
      kind: { type: 'string', enum: ['PROGRESS', 'STAGE', 'BLOCKED'] }, stage: { type: 'string' } } },
    run: ({ consultant_id: cid, project_id: pid, ...input }) =>
      jobVisibleTo(db, cid, pid) ? suggestedAction(db, cid, pid, input) : { error: 'NOT_FOUND', project_id: pid },
  },
  brainx_record_progress: {
    description: '原子完成当前行动、记录本次结果并创建下一行动',
    inputSchema: { type: 'object', required: ['consultant_id', 'project_id', 'action_id', 'summary', 'next_action', 'idempotency_key'], properties: {
      consultant_id: { type: 'string' }, project_id: { type: 'string' }, action_id: { type: 'string' },
      kind: { type: 'string', enum: ['PROGRESS', 'STAGE', 'BLOCKED'] }, stage: { type: 'string' },
      summary: { type: 'string' }, rating: { type: 'number' }, next_action: { type: 'object' },
      idempotency_key: { type: 'string' } } },
    run: ({ consultant_id: cid, project_id: pid, ...input }) =>
      jobVisibleTo(db, cid, pid) ? recordProgress(db, cid, pid, input) : { error: 'NOT_FOUND', project_id: pid },
  },
  brainx_terminal_result: {
    description: '用入职或关闭完成承接；也可为历史完成记录补录终局结果',
    inputSchema: { type: 'object', required: ['consultant_id', 'project_id', 'stage', 'summary', 'idempotency_key'], properties: {
      consultant_id: { type: 'string' }, project_id: { type: 'string' },
      stage: { type: 'string', enum: ['入职', '关闭'] }, summary: { type: 'string' },
      close_reason: { type: 'string', enum: CLOSE_REASONS }, idempotency_key: { type: 'string' } } },
    run: ({ consultant_id: cid, project_id: pid, ...input }) =>
      jobVisibleTo(db, cid, pid) ? recordTerminalResult(db, cid, pid, input) : { error: 'NOT_FOUND', project_id: pid },
  },
  brainx_replay: {
    description: '决策回放：冻结推荐 + 当轮 run + 事件 + 结果（job_now 仅对照）；consultant_id 必填且须与推荐归属一致',
    inputSchema: { type: 'object', required: ['decision_id', 'consultant_id'], properties: {
      decision_id: { type: 'string' }, consultant_id: { type: 'string' } } },
    run: ({ decision_id, consultant_id: cid }) => {
      // 与 HTTP 一致：只能回放自己名下的推荐。consultant_id 必填（roster 校验），
      // 不再提供"缺失时按声明身份兜底"的放行路径（2026-08-20 信任对齐收紧）。
      if (!cid || !loadConsultants(db).some((c) => c.consultant_id === cid)) {
        return { error: 'UNKNOWN_CONSULTANT', consultant_id: cid };
      }
      const owner = db.prepare('SELECT consultant_id FROM recommendations WHERE decision_id=?').get(decision_id);
      if (!owner) return { error: 'NOT_FOUND', decision_id };
      if (owner.consultant_id !== cid) return { error: 'NOT_FOUND', decision_id };
      return replay(db, decision_id);
    },
  },
  brainx_record_outcome: {
    description: '录入结果观察（幂等；重复 idempotency_key 返回 already）',
    inputSchema: { type: 'object', required: ['consultant_id', 'project_id', 'stage'], properties: {
      consultant_id: { type: 'string' }, project_id: { type: 'string' }, stage: { type: 'string' },
      value: { type: 'object' }, decision_id: { type: 'string' }, idempotency_key: { type: 'string' } } },
    run: ({ consultant_id: cid, ...b }) => recordOutcome(db, cid, b),
  },
  brainx_sync_now: {
    description: '触发一次同步（source: fixture|feishu；dry_run=true 只校验不落库）',
    inputSchema: { type: 'object', required: ['consultant_id'], properties: {
      consultant_id: { type: 'string' }, source: { type: 'string' }, dry_run: { type: 'boolean' } } },
    run: ({ consultant_id: cid, source = 'fixture', dry_run = false }) =>
      runSync(db, { source, consultant_id: cid, dry_run }),
  },
  brainx_profile: {
    description: '我的档案（方向画像关键词/备注）；传 profile_keywords 或 profile_note 即更新（仅本人，下一轮推荐生效）',
    inputSchema: { type: 'object', required: ['consultant_id'], properties: {
      consultant_id: { type: 'string' },
      profile_keywords: { type: 'array', items: { type: 'string' } },
      profile_note: { type: 'string' } } },
    run: ({ consultant_id: cid, profile_keywords, profile_note }) => {
      if (profile_keywords !== undefined || profile_note !== undefined) {
        return updateProfile(db, cid, { profile_keywords, profile_note });
      }
      const c = loadConsultants(db).find((x) => x.consultant_id === cid);
      if (!c) return { error: 'NOT_FOUND', consultant_id: cid };
      return { consultant_id: cid, display_name: c.display_name,
               profile_keywords: c.profile_keywords || [], profile_note: c.profile_note || '' };
    },
  },
  brainx_push_preview: {
    description: '预览今日推送卡片（不发送；真发送走 bin/brainx-push.mjs --send，需人确认）',
    inputSchema: { type: 'object', required: ['consultant_id'], properties: {
      consultant_id: { type: 'string' } } },
    run: ({ consultant_id: cid }) => {
      const sync = latestSync(db, cid);
      const snapshot = latestCompleteSnapshot(db, cid);
      const run = latestRun(db, cid);
      const c = commitmentSummary(db, cid);
      const name = loadConsultants(db).find((x) => x.consultant_id === cid)?.display_name || cid;
      return sync && !sync.complete ? buildSyncAlertCard(sync)
        : buildDailyCard({ consultant_name: name, run: run?.run, items: run?.items || [],
                           commitments: c, sync, snapshot_id: snapshot?.sync_id });
    },
  },
};

// —— MCP stdio 协议（NDJSON：每行一个 JSON-RPC 消息）——
const PROTOCOL_VERSION = '2024-11-05';
const respond = (id, resultOrError) => {
  const msg = { jsonrpc: '2.0', id, ...resultOrError };
  process.stdout.write(JSON.stringify(msg) + '\n');
};
const ok = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] });

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification（initialized 等）不回复
  try {
    switch (method) {
      case 'initialize':
        return respond(id, { result: {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'brainx-mcp', version: '1.0.0' },
        } });
      case 'ping':
        return respond(id, { result: {} });
      case 'tools/list':
        return respond(id, { result: { tools: Object.entries(TOOLS).map(([name, t]) => ({
          name, description: t.description, inputSchema: t.inputSchema })) } });
      case 'tools/call': {
        const t = TOOLS[params?.name];
        if (!t) return respond(id, { error: { code: -32601, message: `unknown tool: ${params?.name}` } });
        try {
          return respond(id, { result: ok(t.run(params.arguments || {})) });
        } catch (e) {
          return respond(id, { result: { content: [{ type: 'text',
            text: `ERROR: ${String(e.message || e).slice(0, 500)}` }], isError: true } });
        }
      }
      default:
        return respond(id, { error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    return respond(id, { error: { code: -32603, message: String(e.message || e).slice(0, 300) } });
  }
}

createInterface({ input: process.stdin, terminal: false })
  .on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch { return; }
    handle(msg);
  });
process.stderr.write('brainx-mcp ready (stdio)\n');
