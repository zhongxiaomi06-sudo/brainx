import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const job = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' LIMIT 1`).get();
  const searches = [];
  const handlers = createActionToolHandlers({ db, startSearchFn: (_db, consultantId, jobId, options) => {
    searches.push({ consultantId, jobId, options });
    return { status: 'triggered', task_id: 'search-1' };
  } });
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } };
  return { db, jobId: job.project_id, handlers, searches, context };
}

test('自然语言偏好工具读取默认值并保存时间、数量和开关', () => {
  const { handlers, context } = fixture();
  assert.deepEqual(handlers.brainx_push_preferences({}, context).data.preferences, {
    enabled: true, times: ['07:00', '19:00'], job_count: 3, timezone: 'Asia/Shanghai',
  });
  assert.throws(() => handlers.brainx_update_push_preferences({
    times: ['08:30'], job_count: 5, enabled: true, confirm: false,
  }, context), /INVALID_ARGUMENT/);
  const updated = handlers.brainx_update_push_preferences({
    times: ['08:30', '18:45'], job_count: 5, enabled: true, confirm: true,
  }, context);
  assert.equal(updated.data.preferences.job_count, 5);
  assert.deepEqual(handlers.brainx_push_preferences({}, context).data.preferences.times, ['08:30', '18:45']);
  assert.throws(() => handlers.brainx_update_push_preferences({
    times: ['08:30', '08:45'], confirm: true,
  }, context), /INVALID_ARGUMENT/);
});

test('职位负责人只返回业务身份和可联系状态，不泄露 chat_id', () => {
  const { db, jobId, handlers, context } = fixture();
  db.prepare('UPDATE job_facts SET owner_name=?, owner_unique_id=?, chat_id=? WHERE project_id=?')
    .run('张三', 'owner-ref-1', 'oc_secret', jobId);
  const result = handlers.brainx_job_contacts({ job_id: jobId }, context);
  assert.deepEqual(result.data.owner, {
    display_name: '张三', owner_ref: 'owner-ref-1', linked_chat_available: true,
  });
  assert.equal(JSON.stringify(result).includes('oc_secret'), false);
});

test('确认接单会建立行动并自动启动找人，重复键保持幂等', () => {
  const { db, jobId, handlers, searches, context } = fixture();
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const args = { job_id: jobId, goal: '本周确认职位画像并找到首批候选人',
    action_title: '确认硬性条件', due_at: due, idempotency_key: 'agent:accept:1', confirm: true };
  const first = handlers.brainx_accept_job(args, context);
  assert.equal(first.data.state, 'ACCEPTED');
  assert.equal(searches.length, 1);
  const again = handlers.brainx_accept_job(args, context);
  assert.equal(again.data.state, 'ACCEPTED');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM decision_events WHERE idempotency_key='agent:accept:1'`).get().n, 1);
});

test('机器人可记录进展并建立下一行动', () => {
  const { jobId, handlers, context } = fixture();
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const accepted = handlers.brainx_accept_job({ job_id: jobId, goal: '找到候选人',
    action_title: '启动找人', due_at: due, idempotency_key: 'agent:accept:2', confirm: true }, context);
  const result = handlers.brainx_record_job_progress({
    job_id: jobId, action_id: accepted.data.active_action.action_ref, kind: 'STAGE', stage: '找人中',
    summary: '已完成画像校准并启动第一轮搜索', next_action_title: '筛选首批候选人',
    next_due_at: new Date(Date.now() + 3 * 86400000).toISOString(),
    idempotency_key: 'agent:progress:1', confirm: true,
  }, context);
  assert.equal(result.data.active_action.title, '筛选首批候选人');
});
