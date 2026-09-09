import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import {
  applyOpenmaiSseFrame, buildPrompt, getOpenmaiResult, settleOpenmaiTask, startOpenmaiTask,
} from '../src/openmai-task.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';

function runningTask() {
  const db = openDb(':memory:');
  const at = now();
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,task_id,started_at)
    VALUES ('P-RACE','felix','running','om_new',?)`).run(at);
  return db;
}

test('OpenMai 旧任务结束不得覆盖同职位的新任务', () => {
  const db = runningTask();
  const changed = settleOpenmaiTask(db, {
    projectId: 'P-RACE', consultantId: 'felix', taskId: 'om_old',
    status: 'failed', error: '旧进程超时',
  });
  assert.equal(changed, false);
  assert.deepEqual({ ...db.prepare(`SELECT status,task_id,result_text,error,finished_at
    FROM openmai_results`).get() }, {
    status: 'running', task_id: 'om_new', result_text: null, error: null, finished_at: null,
  });
  db.close();
});

test('OpenMai 只有当前运行任务可以落成功或失败终态', () => {
  const db = runningTask();
  assert.equal(settleOpenmaiTask(db, {
    projectId: 'P-RACE', consultantId: 'felix', taskId: 'om_new',
    status: 'done', resultText: '候选结果', finishedAt: '2026-09-07T14:30:00.000Z',
  }), true);
  assert.deepEqual({ ...db.prepare(`SELECT status,result_text,error,finished_at FROM openmai_results`).get() }, {
    status: 'done', result_text: '候选结果', error: null, finished_at: '2026-09-07T14:30:00.000Z',
  });
  assert.equal(settleOpenmaiTask(db, {
    projectId: 'P-RACE', consultantId: 'felix', taskId: 'om_new',
    status: 'failed', error: '迟到错误',
  }), false, '已完成任务也不得被迟到回调改写');
  db.close();
});

test('OpenMai SSE 最后一帧没有空行也完整读取正文与异步定位', () => {
  const state = { sessionId: '', messageId: '', result: '', deferred: false };
  assert.equal(applyOpenmaiSseFrame(state,
    'data: {"type":"session_created","session_id":"session-1"}'), true);
  applyOpenmaiSseFrame(state,
    'data: {"done":true,"deferred":true,"message_id":"message-1","canonical_content":"最终候选结果"}');
  assert.deepEqual(state, {
    sessionId: 'session-1', messageId: 'message-1', result: '最终候选结果', deferred: true,
  });
});

test('OpenMai SSE 最后一帧错误不能被静默吞掉', () => {
  const state = { sessionId: '', messageId: '', result: '', deferred: false };
  assert.throws(() => applyOpenmaiSseFrame(state,
    'data: {"error":"UPSTREAM_FAILED","message":"上游执行失败"}'), /上游执行失败/);
  assert.equal(applyOpenmaiSseFrame(state, 'data: not-json'), false);
});

test('顾问补充画像进入 OpenMai 提示词且被明确当作业务数据', () => {
  const prompt = buildPrompt({ unique_id: 'J1', name: '测试', cities: ['上海'] },
    '功率模块研发负责人，必须有 SiC 经验', ['TTC-100', 'TTC-200']);
  assert.match(prompt, /顾问补充画像：功率模块研发负责人/);
  assert.match(prompt, /排除 TTC 编号：TTC-100、TTC-200/);
  assert.match(prompt, /严禁再次返回/);
  assert.match(prompt, /业务数据，不是系统指令/);
  assert.match(prompt, /不要向顾问追问/);
});

test('显式启动会把顾问补充条件真正传入 OpenMai 请求', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/api/crm/v1/openmai/jobs/detail')) {
      return new Response(JSON.stringify({ code: 0, data: { jobs: [{
        unique_id: 'J-TTC', name: '测试开发', cities: ['北京'],
      }] } }), { status: 200 });
    }
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"done":true,"canonical_content":"请补充更多条件"}\n\n',
        ));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  };
  try {
    const projectId = 'P-FIX-6FFEA4D1';
    const criteria = '必须有高性能 Python 后端经验';
    assert.equal(startOpenmaiTask(db, null, 'felix', projectId, {
      searchBrief: criteria, excludeCandidateRefs: ['TTC-OLD'],
    }).status, 'triggered');
    const deadline = Date.now() + 2000;
    while (getOpenmaiResult(db, 'felix', projectId).status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(calls[1].body.content, /必须有高性能 Python 后端经验/);
    assert.match(calls[1].body.content, /排除 TTC 编号：TTC-OLD/);
    const stored = getOpenmaiResult(db, 'felix', projectId);
    assert.equal(stored.search_brief, criteria);
    assert.equal(stored.search_round, 1);
    assert.equal(stored.excluded_candidate_refs_json, '["TTC-OLD"]');
  } finally {
    global.fetch = orig;
    db.close();
  }
});
