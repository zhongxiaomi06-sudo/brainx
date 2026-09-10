import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';
import { recommend } from '../src/recommend.js';

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

test('确认接单会建立行动但不自动消耗找人渠道，重复键保持幂等', () => {
  const { db, jobId, handlers, searches, context } = fixture();
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const args = { job_id: jobId, goal: '本周确认职位画像并找到首批候选人',
    action_title: '确认硬性条件', due_at: due, idempotency_key: 'agent:accept:1', confirm: true };
  const first = handlers.brainx_accept_job(args, context);
  assert.equal(first.data.state, 'ACCEPTED');
  assert.equal(searches.length, 0, '接单阶段不得自动选择并消耗 OpenMai');
  assert.equal(first.data.search, undefined);
  assert.ok(first.next_allowed_actions.includes('brainx_openmai_search'),
    '接单后允许用户在项目群另选 OpenMai');
  const again = handlers.brainx_accept_job(args, context);
  assert.equal(again.data.state, 'ACCEPTED');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM decision_events WHERE idempotency_key='agent:accept:1'`).get().n, 1);
});

test('仅在推荐池可见的职位，点击接单时先自动加入本人项目', () => {
  const { db, jobId, handlers, context } = fixture();
  recommend(db, 'felix', { top: 10 });
  db.prepare('DELETE FROM job_memberships WHERE consultant_id=? AND project_id=?').run('felix', jobId);
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM recommendations
    WHERE consultant_id=? AND project_id=?`).get('felix', jobId).count > 0, true);
  const out = handlers.brainx_accept_job({ job_id: jobId, confirm: true }, context);
  assert.equal(out.data.state, 'ACCEPTED');
  assert.equal(db.prepare(`SELECT relation FROM job_memberships
    WHERE consultant_id=? AND project_id=? AND valid_to IS NULL`).get('felix', jobId).relation, 'MY_JOB');
});

test('接单建群成功与失败均如实回传，且不回滚已经完成的接单', async () => {
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const args = (jobId, key) => ({ job_id: jobId, goal: '找到首批候选人',
    action_title: '启动找人', due_at: due, idempotency_key: key, confirm: true });

  const done = fixture();
  const dOut = await createActionToolHandlers({ db: done.db,
    acceptLaunchFn: async () => ({ launch: { status: 'READY' } }) })
    .brainx_accept_job(args(done.jobId, 'agent:accept:done'), done.context);
  assert.equal(dOut.data.state, 'ACCEPTED');
  assert.deepEqual(dOut.data.project_group, { ready: true });
  assert.match(dOut.unknowns.join(''), /项目群已就绪/);

  const failed = fixture();
  const fOut = await createActionToolHandlers({ db: failed.db,
    acceptLaunchFn: async () => { throw Object.assign(new Error('飞书暂不可用'), { code: 'FEISHU_DOWN' }); } })
    .brainx_accept_job(args(failed.jobId, 'agent:accept:failed'), failed.context);
  assert.equal(fOut.data.state, 'ACCEPTED');
  assert.deepEqual(fOut.data.project_group, { ready: false, code: 'FEISHU_DOWN' });
  assert.match(fOut.unknowns.join(''), /项目群创建失败.*飞书暂不可用/);
});

test('接单最小参数只需 job_id + confirm，默认值由服务端生成（specs/011）', () => {
  const { db, jobId, handlers, context } = fixture();
  const first = handlers.brainx_accept_job({ job_id: jobId, confirm: true }, context);
  assert.equal(first.data.state, 'ACCEPTED');
  const action = db.prepare(`SELECT title, goal, due_at, idempotency_key FROM commitment_actions
    WHERE consultant_id='felix' AND project_id=?`).get(jobId);
  assert.equal(action.title, '启动候选人搜索并跟进交付');
  assert.equal(action.goal, '完成候选人搜索、筛选与匹配评估');
  assert.ok(action.due_at, '截止时间应自动生成');
  assert.equal(action.idempotency_key, `bot:accept:felix:${jobId}:action`);
  // 同参重复调用：确定性幂等键命中 already 分支，不产生第二条行动
  const again = handlers.brainx_accept_job({ job_id: jobId, confirm: true }, context);
  assert.equal(again.data.state, 'ACCEPTED');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM commitment_actions
    WHERE consultant_id='felix' AND project_id=?`).get(jobId).n, 1);
  // 显式传参仍然优先于默认值（旧用法回归）
  const other = fixture();
  other.handlers.brainx_accept_job({ job_id: other.jobId, goal: '本周出首批名单',
    action_title: '确认硬性条件', idempotency_key: 'agent:accept:legacy', confirm: true }, other.context);
  const legacy = other.db.prepare(`SELECT title, goal FROM commitment_actions
    WHERE idempotency_key='agent:accept:legacy:action'`).get();
  assert.equal(legacy.title, '确认硬性条件');
  assert.equal(legacy.goal, '本周出首批名单');
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
