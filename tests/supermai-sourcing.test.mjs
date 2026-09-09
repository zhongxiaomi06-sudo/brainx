import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import { getOpenmaiResult } from '../src/openmai-task.js';
import {
  supermaiCriteriaKey, buildScoutPrompt, startSupermaiScoutTask,
} from '../src/supermai-sourcing.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';

function seededDb() {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  return db;
}

const CRITERIA = '北京 5年 React 资深前端工程师';
const DONE_RESULT = [
  '1. 张三（Acme · 高级前端）——匹配。',
  '<!-- BRAINX_CANDIDATES_V1',
  '{"candidates":[{"candidate_ref":"c1","name":"张三","evaluation":"5年React，匹配","resume_url":null}]}',
  '-->',
].join('\n');

/** SSE 流式 mock：completions 一次性吐完所有帧。 */
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

/** 轮询等待异步 settle 完成。 */
async function waitForStatus(db, consultantId, projectId, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = getOpenmaiResult(db, consultantId, projectId);
    if (row.status === 'done' || row.status === 'failed') return row;
    await new Promise((r) => setTimeout(r, 20));
  }
  return getOpenmaiResult(db, consultantId, projectId);
}

test('supermaiCriteriaKey：同判据同键、异判据异键、空白归一', () => {
  const a = supermaiCriteriaKey('北京 5年 React 资深前端');
  assert.ok(a.startsWith('supermai:'), '合成键带 supermai: 前缀');
  assert.equal(a, supermaiCriteriaKey('北京 5年 React 资深前端'), '同判据同键');
  assert.equal(a, supermaiCriteriaKey('  北京 5年 React 资深前端  '), '首尾空白不影响键');
  assert.notEqual(a, supermaiCriteriaKey('上海 5年 React 资深前端'), '异判据异键');
});

test('buildScoutPrompt：渠道为猎聘/脉脉，携带判据与 BRAINX_CANDIDATES_V1 机器块格式', () => {
  const prompt = buildScoutPrompt(CRITERIA);
  assert.ok(prompt.includes(CRITERIA), '判据原文进入提示词');
  assert.ok(prompt.includes('猎聘') && prompt.includes('脉脉'), '渠道表述为猎聘/脉脉');
  assert.ok(prompt.includes('BRAINX_CANDIDATES_V1'), '机器块格式与 job 模式一致（交付解析器复用）');
  assert.ok(prompt.includes('待核实'), '无证据字段必须写待核实');
});

test('无有效 TTC 凭证：快速失败落库 failed，不发起任何请求（fail-closed）', async () => {
  const db = openDb(':memory:'); // 不注入 JWT
  let called = 0;
  const orig = global.fetch;
  global.fetch = async () => { called += 1; return sseResponse([]); };
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'error');
    assert.ok(out.message.includes('TTC 凭证'));
    await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
    const row = getOpenmaiResult(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(row.status, 'failed');
    assert.equal(called, 0, '无凭证不得发起请求');
  } finally {
    global.fetch = orig;
  }
});

test('E2E：触发 → running（sm_ 任务号）→ completions criteria 模式（无 job_id）→ done 复用', async () => {
  const db = seededDb();
  const bodies = [];
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    bodies.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return sseResponse([
      { session_id: 'sess-sm-1', type: 'session_created' },
      { type: 'message_started' },
      { content: '寻找中…', done: false, role: 'assistant' },
      { done: true, message_id: 'm1', canonical_content: DONE_RESULT },
    ]);
  };
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'triggered');
    assert.ok(out.task_id.startsWith('sm_'), '任务号 sm_ 前缀');

    const row = getOpenmaiResult(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(row.status, 'running', '落库 openmai_results（合成 project_id）');

    const settled = await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(settled.status, 'done');
    assert.ok(settled.result_text.includes('张三'), '结果文本落库');

    const call = bodies[0];
    assert.ok(call.url.includes('/api/openmai/v1/completions'), '走 OpenMai completions 引擎');
    assert.equal(call.body.job_id, undefined, 'criteria 模式不带 job_id');
    assert.ok(call.body.content.includes(CRITERIA), 'content 携带判据提示词');

    const again = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(again.status, 'already_done', 'done 后同判据复用结果（费用防重）');
  } finally {
    global.fetch = orig;
  }
});

test('项目模式：使用真实项目编号落库并保留判据供原群投递', async () => {
  const db = seededDb();
  const bodies = [];
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    bodies.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return sseResponse([{ done: true, canonical_content: DONE_RESULT }]);
  };
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA, {
      projectId: 'P-PROJECT', excludeCandidateRefs: ['TTC-OLD'],
    });
    assert.equal(out.status, 'triggered');
    const settled = await waitForStatus(db, 'felix', 'P-PROJECT');
    assert.equal(settled.status, 'done');
    assert.equal(settled.search_brief, CRITERIA);
    assert.equal(settled.excluded_candidate_refs_json, '["TTC-OLD"]');
    assert.equal(bodies[0].body.job_id, undefined, 'SuperMai 仍以判据模式调用');
    assert.ok(bodies[0].body.content.includes(CRITERIA));
    assert.match(bodies[0].body.content, /排除 TTC 编号.*TTC-OLD/);
  } finally {
    global.fetch = orig;
  }
});

test('completions 失败 → failed 落库；60s 冷却内拒绝重启，force 可重试', async () => {
  const db = seededDb();
  const orig = global.fetch;
  global.fetch = async () => new Response('boom', { status: 500 });
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'triggered');
    const settled = await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(settled.status, 'failed');

    const retry = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(retry.status, 'error', '失败 60s 冷却内不重启（费用防重）');
    assert.ok(retry.message.includes('1 分钟'));

    const forced = startSupermaiScoutTask(db, null, 'felix', CRITERIA, { force: true });
    assert.equal(forced.status, 'triggered', 'force 显式重试不受冷却限制');
    await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
  } finally {
    global.fetch = orig;
  }
});

test('并发防重：running 集合内同判据触发返回 running（不重复起任务）', async () => {
  const db = seededDb();
  const orig = global.fetch;
  let release;
  const gate = new Promise((r) => { release = r; });
  global.fetch = async () => {
    await gate; // 挂住请求，模拟长任务
    return sseResponse([{ done: true, canonical_content: DONE_RESULT }]);
  };
  try {
    const first = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(first.status, 'triggered');
    const second = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(second.status, 'running', '同判据并发触发去重');
    release();
    await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
  } finally {
    global.fetch = orig;
  }
});

test('looksLikeSessionPollution：识别会话污染元回复，不误伤正常找人结果', async () => {
  const { looksLikeSessionPollution } = await import('../src/openmai-result.js');
  assert.equal(looksLikeSessionPollution('我这边没有可恢复的上一轮运行上下文：当前会话列表为空'), true);
  assert.equal(looksLikeSessionPollution('我接上次进度：你在看职位 J5Z8J10 的岗匹人。'), true);
  assert.equal(looksLikeSessionPollution('可见的历史任务只有：1. Lovart 2. FDE'), true);
  assert.equal(looksLikeSessionPollution(''), false, '空文本不算污染（NO_REPLY 另有处理）');
  assert.equal(looksLikeSessionPollution(DONE_RESULT), false, '正常候选人结果不误伤');
  assert.equal(looksLikeSessionPollution('未找到匹配候选人，建议放宽条件'), false, '正常零命中不误伤');
});

test('会话污染自动重试：首次元回复自动重发，第二次成功则正常交付', async () => {
  const db = seededDb();
  const bodies = [];
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async (url, init = {}) => {
    bodies.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    calls += 1;
    const content = calls === 1
      ? '我这边没有可恢复的上一轮运行上下文：当前会话列表为空。'
      : DONE_RESULT;
    return sseResponse([{ done: true, message_id: 'm' + calls, canonical_content: content }]);
  };
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'triggered');
    const settled = await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(settled.status, 'done', '污染回复自动重试后正常交付');
    assert.ok(settled.result_text.includes('张三'));
    assert.equal(bodies.length, 2, '恰好重试一次');
    for (const b of bodies) {
      assert.ok(b.body.content.includes('【会话隔离'), '每次调用都带会话隔离前言');
      assert.ok(b.body.content.includes(CRITERIA), '判据仍然在场');
    }
  } finally {
    global.fetch = orig;
  }
});

test('会话污染二次重试仍元回复 → failed 关闭并明确报错，不交付垃圾', async () => {
  const db = seededDb();
  const orig = global.fetch;
  const pollution = '我接上次进度：你在看职位 J5Z8J10 的岗匹人。';
  global.fetch = async () => sseResponse([{ done: true, canonical_content: pollution }]);
  try {
    const out = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(out.status, 'triggered');
    const settled = await waitForStatus(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(settled.status, 'failed');
    assert.ok(settled.error.includes('会话上下文污染'), '错误信息点名污染');
  } finally {
    global.fetch = orig;
  }
});
