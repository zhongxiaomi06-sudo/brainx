/** business-events.test.mjs — specs/019 US1：五类业务动作补发标准信封事件（测试先行）。
 *
 * 权威契约: specs/019-hub-event-backbone/contracts/event-types.md；
 * 判定要点：动作成功 → 账本有对应事件；同幂等键重放 → 不新增事件；
 * payload 只放锚点/计数（无正文 PII），证据走 evidence_refs 引用。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDb, eventsByType, countEvents } from './helpers/event-ledger.js';
import { runSync } from '../src/sync.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';
import { recordOutcome } from '../src/replay.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';
import { consumeJobExtract } from '../src/job-extract/index.js';
import { confirmDraft, rejectDraft } from '../src/job-extract/confirm.js';
import { consumeJudgmentExtract } from '../src/judgment-extract/index.js';
import { confirmJudgment, rejectJudgment } from '../src/judgment-extract/confirm.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import { getOpenmaiResult, settleOpenmaiTask } from '../src/openmai-task.js';
import { startSupermaiScoutTask, supermaiCriteriaKey } from '../src/supermai-sourcing.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';

/** 接单夹具（模式同 tests/agent-action-tools.test.mjs）。 */
function acceptFixture() {
  const db = createLedgerDb();
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const job = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' LIMIT 1`).get();
  const handlers = createActionToolHandlers({
    db, startSearchFn: () => ({ status: 'triggered', task_id: 'search-1' }),
  });
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } };
  return { db, jobId: job.project_id, handlers, context };
}

test('US1: 接单成功产 job.accepted 事件；重复接单幂等不新增', () => {
  const { db, jobId, handlers, context } = acceptFixture();
  const args = { job_id: jobId, confirm: true, idempotency_key: 'agent:accept:evt1' };
  const out = handlers.brainx_accept_job(args, context);
  assert.equal(out.data.state, 'ACCEPTED');

  const events = eventsByType(db, 'job.accepted');
  assert.equal(events.length, 1, '接单应产一条 job.accepted 事件');
  assert.equal(events[0].idem_key, `job.accepted:${jobId}:felix`);
  assert.equal(events[0].actor, 'user:felix');
  assert.deepEqual(events[0].payload, {
    project_id: jobId, consultant_id: 'felix', source: 'private_chat',
  });

  handlers.brainx_accept_job(args, context); // 同幂等键重放
  assert.equal(countEvents(db, 'job.accepted'), 1, '重复接单不得重复产事件');
});

test('US1: 终局记录产 job.terminal_recorded 事件；同幂等键重放不新增', () => {
  const { db, jobId } = acceptFixture();
  const r = recordOutcome(db, 'felix', {
    project_id: jobId, stage: 'OFFER', value: {}, idempotency_key: 'oc-evt-1',
  });
  assert.equal(r.ok, true);

  const events = eventsByType(db, 'job.terminal_recorded');
  assert.equal(events.length, 1);
  assert.equal(events[0].idem_key, 'oc-evt-1', '幂等键复用 job_outcomes 既有键');
  assert.equal(events[0].actor, 'user:felix');
  assert.deepEqual(events[0].payload, { project_id: jobId, stage: 'OFFER', kind: null });
  assert.deepEqual(events[0].evidence_refs, [{ table: 'job_outcomes', id: String(r.outcome_id) }]);

  const dup = recordOutcome(db, 'felix', {
    project_id: jobId, stage: 'OFFER', value: {}, idempotency_key: 'oc-evt-1',
  });
  assert.equal(dup.already, true);
  assert.equal(countEvents(db, 'job.terminal_recorded'), 1);
});

/** 走 E1 全链路产出一条 pending 职位草稿（模式同 tests/job-extract-confirm.test.mjs）。 */
function makeJobDraft(db, text, messageId) {
  registerChatContext(db, { chat_id: 'oc_g', bot_mode: 'ALL' });
  processLarkEvent(db, {
    message_id: messageId, chat_id: 'oc_g', open_id: 'ou_u',
    mentions: [], message_type: 'text',
    create_time: '2026-09-23T12:00:00+08:00', body: { text },
  });
  const row = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?')
    .get(`lark:message:${messageId}`);
  consumeJobExtract(db, row.event_id);
  const draft = db.prepare('SELECT * FROM job_facts_drafts WHERE message_id=?').get(messageId);
  assert.ok(draft, `应产出草稿: ${text}`);
  return draft;
}

test('US1: 职位草稿确认/拒绝产 job_fact.reviewed 事件（domain=job），终态防重', () => {
  const db = createLedgerDb();
  const draft = makeJobDraft(db, '星曜科技急招后端工程师，HC 2，base 上海', 'om_be_1');
  const r = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const events = eventsByType(db, 'job_fact.reviewed');
  assert.equal(events.length, 1);
  assert.equal(events[0].idem_key, `job_fact.reviewed:job:${draft.draft_id}`);
  assert.equal(events[0].actor, 'user:felix');
  assert.deepEqual(events[0].payload, {
    domain: 'job', draft_id: draft.draft_id, action: 'confirm', project_id: r.project_id,
  });
  assert.deepEqual(events[0].evidence_refs, [{ table: 'job_facts_drafts', id: draft.draft_id }]);

  const again = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(again.ok, false, '重复确认 409');
  assert.equal(countEvents(db, 'job_fact.reviewed'), 1);

  const draft2 = makeJobDraft(db, '蓝海智能招算法工程师，base 北京', 'om_be_2');
  const rr = rejectDraft(db, { draft_id: draft2.draft_id, consultant_id: 'felix' });
  assert.equal(rr.ok, true);
  const all = eventsByType(db, 'job_fact.reviewed');
  assert.equal(all.length, 2);
  const rejectEvent = all.find((e) => e.payload.draft_id === draft2.draft_id);
  assert.ok(rejectEvent, '拒绝草稿也应产事件');
  assert.equal(rejectEvent.payload.action, 'reject');
  assert.equal(rejectEvent.payload.domain, 'job');
});

/** 走全链路产出一条 pending 判断草稿（模式同 tests/judgment-extract-confirm.test.mjs）。 */
function makeJudgmentDraft(db, text, messageId) {
  registerChatContext(db, { chat_id: 'oc_g', bot_mode: 'ALL' });
  processLarkEvent(db, {
    message_id: messageId, chat_id: 'oc_g', open_id: 'ou_u',
    mentions: [], message_type: 'text',
    create_time: '2026-09-23T12:00:00+08:00', body: { text },
  });
  const row = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?')
    .get(`lark:message:${messageId}`);
  consumeJudgmentExtract(db, row.event_id);
  const draft = db.prepare('SELECT * FROM judgment_drafts WHERE message_id=?').get(messageId);
  assert.ok(draft, `应产出判断草稿: ${text}`);
  return draft;
}

test('US1: 判断草稿确认/拒绝产 job_fact.reviewed 事件（domain=judgment）', () => {
  const db = createLedgerDb();
  const draft = makeJudgmentDraft(db, '星曜科技说：不接受异地候选人', 'om_be_j1');
  const r = confirmJudgment(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const events = eventsByType(db, 'job_fact.reviewed');
  assert.equal(events.length, 1);
  assert.equal(events[0].idem_key, `job_fact.reviewed:judgment:${draft.draft_id}`);
  assert.equal(events[0].payload.domain, 'judgment');
  assert.equal(events[0].payload.action, 'confirm');
  assert.deepEqual(events[0].evidence_refs, [{ table: 'judgment_drafts', id: draft.draft_id }]);

  const draft2 = makeJudgmentDraft(db, '蓝海智能说：只要 985 背景的候选人', 'om_be_j2');
  assert.equal(rejectJudgment(db, { draft_id: draft2.draft_id, consultant_id: 'felix' }).ok, true);
  const all = eventsByType(db, 'job_fact.reviewed');
  assert.equal(all.length, 2);
  const rejectEvent = all.find((e) => e.payload.draft_id === draft2.draft_id);
  assert.ok(rejectEvent, '拒绝草稿也应产事件');
  assert.equal(rejectEvent.payload.action, 'reject');
});

// ---- 找人事件（模式同 tests/supermai-sourcing.test.mjs 的 SSE mock） ----

const CRITERIA = '北京 5年 React 资深前端工程师';
const DONE_RESULT = [
  '1. 张三（Acme · 高级前端）——匹配。',
  '<!-- BRAINX_CANDIDATES_V1',
  '{"candidates":[{"candidate_ref":"c1","name":"张三","evaluation":"5年React，匹配","resume_url":null}]}',
  '-->',
].join('\n');

function sseResponse(frames) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n') + '\n\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

async function waitForStatus(db, consultantId, projectId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = getOpenmaiResult(db, consultantId, projectId);
    if (row.status === 'done' || row.status === 'failed') return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return getOpenmaiResult(db, consultantId, projectId);
}

test('US1: 找人触发产 sourcing.search_started，结算产 sourcing.search_finished（success+计数）', async () => {
  const db = createLedgerDb();
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const orig = global.fetch;
  global.fetch = async () => sseResponse([{ done: true, canonical_content: DONE_RESULT }]);
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'triggered');
    const pid = supermaiCriteriaKey(CRITERIA);

    const started = eventsByType(db, 'sourcing.search_started');
    assert.equal(started.length, 1, '触发应产 search_started');
    assert.equal(started[0].idem_key, `sourcing.started:${pid}:${out.task_id}`);
    assert.equal(started[0].actor, 'agent:brainx_supermai_scout');
    assert.deepEqual(started[0].payload, { project_id: pid, channel: 'supermai', round: 1 });

    const settled = await waitForStatus(db, 'felix', pid);
    assert.equal(settled.status, 'done');
    const finished = eventsByType(db, 'sourcing.search_finished');
    assert.equal(finished.length, 1, '结算应产 search_finished');
    assert.equal(finished[0].idem_key, `sourcing.finished:${pid}:${out.task_id}`);
    assert.equal(finished[0].actor, 'system:worker');
    assert.equal(finished[0].payload.channel, 'supermai');
    assert.equal(finished[0].payload.status, 'success');
    assert.equal(finished[0].payload.result_count, 1, '结果计数来自候选人机器块，不含名单正文');

    const again = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(again.status, 'already_done');
    assert.equal(countEvents(db, 'sourcing.search_started'), 1, '复用结果不得重复产事件');
  } finally {
    global.fetch = orig;
  }
});

test('US1: 无 TTC 凭证快速失败产 sourcing.search_finished（error），不产 search_started', async () => {
  const db = createLedgerDb(); // 不注入 JWT
  const orig = global.fetch;
  let called = 0;
  global.fetch = async () => { called += 1; return sseResponse([]); };
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'error');
    assert.equal(called, 0, '无凭证不得发起请求');
    const pid = supermaiCriteriaKey(CRITERIA);

    assert.equal(countEvents(db, 'sourcing.search_started'), 0, '未启动不产 started');
    const finished = eventsByType(db, 'sourcing.search_finished');
    assert.equal(finished.length, 1, '凭证失败也要留痕（错误可调度）');
    assert.equal(finished[0].payload.status, 'error');
    assert.equal(finished[0].payload.result_count, 0);
    assert.equal(finished[0].payload.channel, 'supermai');
  } finally {
    global.fetch = orig;
  }
});

test('US1: 找人中断超时回收（failStaleOpenmaiTasks）产 search_finished error 事件', async () => {
  const { failStaleOpenmaiTasks } = await import('../src/openmai-delivery.js');
  const db = createLedgerDb();
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  db.prepare(`INSERT INTO openmai_results
    (project_id, consultant_id, status, task_id, started_at, search_round)
    VALUES ('pj_stale', 'felix', 'running', 'om_stale1', ?, 1)`).run(old);
  const recovered = failStaleOpenmaiTasks(db);
  assert.equal(recovered, 1);

  const events = eventsByType(db, 'sourcing.search_finished');
  assert.equal(events.length, 1);
  assert.equal(events[0].idem_key, 'sourcing.finished:pj_stale:om_stale1');
  assert.equal(events[0].payload.status, 'error');
  assert.equal(events[0].payload.channel, 'openmai', 'om_ 任务号前缀识别渠道');
});

test('US1: settleOpenmaiTask 直接结算产 search_finished；重复结算（非 running）不重发', () => {
  const db = createLedgerDb();
  db.prepare(`INSERT INTO openmai_results
    (project_id, consultant_id, status, task_id, started_at, search_round)
    VALUES ('pj_x', 'felix', 'running', 'om_t1', ?, 2)`).run(new Date().toISOString());
  const ok = settleOpenmaiTask(db, {
    projectId: 'pj_x', consultantId: 'felix', taskId: 'om_t1',
    status: 'done', resultText: DONE_RESULT, channel: 'openmai', resultCount: 3,
  });
  assert.equal(ok, true);
  const events = eventsByType(db, 'sourcing.search_finished');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {
    project_id: 'pj_x', channel: 'openmai', round: 2, status: 'success', result_count: 3,
  });

  const again = settleOpenmaiTask(db, {
    projectId: 'pj_x', consultantId: 'felix', taskId: 'om_t1', status: 'failed', error: 'x',
  });
  assert.equal(again, false, '非 running 结算无效');
  assert.equal(countEvents(db, 'sourcing.search_finished'), 1);
});
