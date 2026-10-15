/**
 * sourcing-events.test.mjs — SuperMai 找人事件写入回归（specs/019 hub event backbone）。
 *
 * 固化写入流程：startSupermaiScoutTask 触发找人必须发 sourcing.search_started +
 * sourcing.search_finished 两条事件，幂等键格式正确，actor 区分清楚。
 *
 * 防回归点：sm_1e6c6e7f 老路径漏 search_started 事件（actor=system:worker 只 finished）
 * —— 本测试断言 startSupermaiScoutTask 走完整链路必发两事件。
 *
 * 关联文档：docs/sourcing-write-flow-2026-10-15.md §3.2 事件写入幂等契约
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import { getOpenmaiResult } from '../src/openmai-task.js';
import { supermaiCriteriaKey, startSupermaiScoutTask } from '../src/supermai-sourcing.js';
import { emitEvent } from '../src/hub/emit.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';
const CRITERIA = '北京 5年 React 资深前端工程师，女生优先';

const DONE_RESULT = [
  '1. 张三（Acme · 高级前端）——匹配。',
  '<!-- BRAINX_CANDIDATES_V1',
  '{"candidates":[{"candidate_ref":"c1","name":"张三","evaluation":"5年React，匹配","resume_url":null}]}',
  '-->',
].join('\n');

function seededDb() {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return db;
}

function sseResponse(frames, { status = 200 } = {}) {
  const text = frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n\n') + '\n\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(status === 200 ? stream : text, { status });
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

function eventsForTask(db, projectId, task_id) {
  return db.prepare(
    "SELECT event_id, idem_key, event_type, actor, occurred_at, payload FROM workflow_event_log " +
    "WHERE idem_key LIKE ? OR idem_key LIKE ? ORDER BY occurred_at ASC",
  ).all(
    `%${projectId}:${task_id}%`,
    `%${projectId}%`,
  ).filter((e) => e.idem_key.includes(`:${task_id}`) || e.idem_key.includes(':cred-r'));
}

test('SuperMai 找人：started + finished 两事件必发，actor/幂等键正确', async () => {
  const db = seededDb();
  const orig = global.fetch;
  global.fetch = async () => sseResponse([
    { session_id: 'sess-1', type: 'session_created' },
    { done: true, message_id: 'm1', canonical_content: DONE_RESULT },
  ]);
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'triggered');
    const projectId = supermaiCriteriaKey(CRITERIA);
    const task_id = out.task_id;
    assert.ok(task_id.startsWith('sm_'), 'task_id sm_ 前缀');

    // search_started 事件立即可见（INSERT running 后 emit，先于 await callOpenmaiContent）
    const startedEvents = db.prepare(
      "SELECT event_type, actor, payload FROM workflow_event_log WHERE idem_key = ?",
    ).get(`sourcing.started:${projectId}:${task_id}`);
    assert.ok(startedEvents, 'search_started 事件必发');
    assert.equal(startedEvents.event_type, 'sourcing.search_started');
    assert.equal(startedEvents.actor, 'agent:brainx_supermai_scout',
      'started actor 是 agent:brainx_supermai_scout（非 system:worker）');
    const startedPayload = JSON.parse(startedEvents.payload || '{}');
    assert.equal(startedPayload.project_id, projectId);
    assert.equal(startedPayload.channel, 'supermai');
    assert.equal(startedPayload.round, 1);

    // 等待 settle 后 search_finished 可见
    const settled = await waitForStatus(db, 'felix', projectId);
    assert.equal(settled.status, 'done');

    const finishedEvents = db.prepare(
      "SELECT event_type, actor, payload FROM workflow_event_log WHERE idem_key = ?",
    ).get(`sourcing.finished:${projectId}:${task_id}`);
    assert.ok(finishedEvents, 'search_finished 事件必发');
    assert.equal(finishedEvents.event_type, 'sourcing.search_finished');
    assert.equal(finishedEvents.actor, 'system:worker',
      'finished actor 是 system:worker（settleOpenmaiTask 内部默认）');
    const finishedPayload = JSON.parse(finishedEvents.payload || '{}');
    assert.equal(finishedPayload.status, 'success');
    assert.equal(finishedPayload.result_count, 1);
  } finally {
    global.fetch = orig;
    db.close();
  }
});

test('凭证失败快速失败：只发 search_finished（idem_key 含 cred-r 标记）', async () => {
  const db = openDb(':memory:'); // 不注入 JWT
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; return sseResponse([]); };
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'error');
    const projectId = supermaiCriteriaKey(CRITERIA);
    // 凭证失败走 cred-r 路径：只有 finished，没有 started
    const credFinished = db.prepare(
      "SELECT event_type, actor, payload FROM workflow_event_log WHERE idem_key = ?",
    ).get(`sourcing.finished:${projectId}:cred-r1`);
    assert.ok(credFinished, '凭证失败也发 search_finished（带 cred-r 标记）');
    assert.equal(credFinished.actor, 'agent:brainx_supermai_scout');
    const payload = JSON.parse(credFinished.payload || '{}');
    assert.equal(payload.status, 'error');
    assert.equal(payload.result_count, 0);

    const credStarted = db.prepare(
      "SELECT event_type FROM workflow_event_log WHERE idem_key = ?",
    ).get(`sourcing.started:${projectId}:cred-r1`);
    assert.equal(credStarted, undefined, '凭证失败不发 started（任务未启动）');
    assert.equal(calls, 0, '无凭证不发付费请求');
  } finally {
    global.fetch = orig;
    db.close();
  }
});

test('幂等键去重：同 task_id 重复 emit 不产生新行（dedup 路径）', () => {
  const db = seededDb();
  const projectId = 'supermai:test-dedup';
  const task_id = 'sm_dedup0001';
  // 第一次 INSERT
  db.prepare(`INSERT INTO openmai_results
    (project_id, consultant_id, status, task_id, started_at, search_brief, search_round,
     excluded_candidate_refs_json)
    VALUES (?, 'felix', 'running', ?, '2026-10-15T00:00:00.000Z', 'test', 1, '[]')`).run(projectId, task_id);

  const r1 = emitEvent(db, {
    event_type: 'sourcing.search_started',
    idem_key: `sourcing.started:${projectId}:${task_id}`,
    actor: 'agent:brainx_supermai_scout',
    payload: { project_id: projectId, channel: 'supermai', round: 1 },
    evidence_refs: [{ table: 'openmai_results', id: `${projectId}|felix` }],
  });
  assert.ok(r1.ok && !r1.deduplicated, '第一次 emit 真插入');

  const r2 = emitEvent(db, {
    event_type: 'sourcing.search_started',
    idem_key: `sourcing.started:${projectId}:${task_id}`,
    actor: 'agent:brainx_supermai_scout',
    payload: { project_id: projectId, channel: 'supermai', round: 1 },
    evidence_refs: [{ table: 'openmai_results', id: `${projectId}|felix` }],
  });
  assert.ok(r2.ok && r2.deduplicated, '第二次同 idem_key 返回 deduplicated=true');

  const count = db.prepare(
    "SELECT COUNT(*) as cnt FROM workflow_event_log WHERE idem_key = ?",
  ).get(`sourcing.started:${projectId}:${task_id}`);
  assert.equal(count.cnt, 1, '表里仍只 1 行（幂等去重生效）');
  db.close();
});
