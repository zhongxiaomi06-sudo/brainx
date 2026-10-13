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

test('确认接单会建立行动并等待顾问选择找人渠道，重复键保持幂等', () => {
  const { db, jobId, handlers, searches, context } = fixture();
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const args = { job_id: jobId, goal: '本周确认职位画像并找到首批候选人',
    action_title: '确认硬性条件', due_at: due, idempotency_key: 'agent:accept:1', confirm: true };
  const first = handlers.brainx_accept_job(args, context);
  assert.equal(first.data.state, 'ACCEPTED');
  assert.equal(searches.length, 0, '接单不得暗中选择或启动付费找人渠道');
  assert.equal(first.data.search.status, 'awaiting_method');
  assert.ok(first.unknowns.some((u) => u.includes('明确选择 OpenMai 或 SuperMai')),
    '接单后必须明确告诉顾问下一步由人选择渠道');
  assert.ok(first.next_allowed_actions.includes('brainx_launch_project_chat'),
    '私聊接单后应先允许建立或复用项目群');
  assert.ok(first.next_allowed_actions.includes('brainx_openmai_search'),
    '接单后应把 openmai_search 列为下一步允许动作');
  const again = handlers.brainx_accept_job(args, context);
  assert.equal(again.data.state, 'ACCEPTED');
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM decision_events WHERE idempotency_key='agent:accept:1'`).get().n, 1);
  // 2026-09-12 D5 灰测实证：接单必须落 MY_JOB 成员关系，否则 launchProjectChat 报 PROJECT_MEMBERSHIP_REQUIRED
  assert.equal(db.prepare(`SELECT relation FROM job_memberships
    WHERE consultant_id='felix' AND project_id=? AND valid_to IS NULL`).get(jobId)?.relation, 'MY_JOB');
});

test('接单不会调用注入的找人实现，渠道必须由后续显式动作启动', () => {
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const args = (jobId, key) => ({ job_id: jobId, goal: '找到首批候选人',
    action_title: '启动找人', due_at: due, idempotency_key: key, confirm: true });

  const current = fixture();
  let calls = 0;
  const out = createActionToolHandlers({ db: current.db, startSearchFn: () => {
    calls += 1;
    throw new Error('接单不应调用找人实现');
  } }).brainx_accept_job(args(current.jobId, 'agent:accept:awaiting'), current.context);
  assert.equal(out.data.state, 'ACCEPTED');
  assert.equal(out.data.search.status, 'awaiting_method');
  assert.equal(calls, 0);
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

// specs/017：飞书私聊接单不会建群（只有 web 接单会），agent 侧补一个建群入口。
test('建群工具（specs/017）：带确认才建群，幂等键按顾问+职位固定', async () => {
  const calls = [];
  const launchFn = async (_db, consultantId, projectId, input) => {
    calls.push({ consultantId, projectId, input });
    return { ok: true, already: false, launch: { launch_id: 'L-1', consultant_id: consultantId,
      project_id: projectId, status: 'READY', chat_id: 'oc_project', chat_name: '海马云-产品经理',
      openclaw_status: 'OK' } };
  };
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' LIMIT 1`).get().project_id;
  const handlers = createActionToolHandlers({ db, launchProjectFn: launchFn });
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } };

  // 未带确认不建群
  await assert.rejects(() => handlers.brainx_launch_project_chat({ job_id: jobId }, context), /INVALID_ARGUMENT/);
  assert.equal(calls.length, 0, '未确认不得触发建群');

  const out = await handlers.brainx_launch_project_chat({ job_id: jobId, confirm: true }, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].projectId, jobId);
  assert.equal(calls[0].input.idempotency_key, `agent-launch:felix:${jobId}`, '幂等键必须固定，重复调用不重复建群');
  assert.equal(out.data.chat_id, 'oc_project');
  assert.equal(out.data.status, 'READY');
  assert.ok(out.next_allowed_actions.includes('brainx_openmai_search'));

  // 已经是 READY 的职位：底层返回 already=true，工具如实透出，不谎报新建
  const already = await createActionToolHandlers({ db, launchProjectFn: async () => ({
    ok: true, already: true, launch: { launch_id: 'L-1', status: 'READY', chat_id: 'oc_project', openclaw_status: 'OK' },
  }) }).brainx_launch_project_chat({ job_id: jobId, confirm: true }, context);
  assert.equal(already.data.already, true);
  assert.ok(already.unknowns.some((u) => u.includes('已经存在')), '已存在的群要明说，避免顾问以为又建了一个');
  db.close();
});

// 回归（2026-09-12 生产冒烟）：旧 launch 行没有 openclaw_status 列值时为 undefined，
// 安全投影会把 undefined 字段判为 INTERNAL 500——工具必须把缺失值归一成 null。
test('建群工具（specs/017）：openclaw_status 缺失时归一为 null，不触发投影 500', async () => {
  const { assertSafeAgentProjection } = await import('../src/agent-gateway/projection.js');
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' LIMIT 1`).get().project_id;
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } };
  const out = await createActionToolHandlers({ db, launchProjectFn: async () => ({
    ok: true, already: true, launch: { launch_id: 'L-1', status: 'READY', chat_id: 'oc_project', openclaw_status: undefined },
  }) }).brainx_launch_project_chat({ job_id: jobId, confirm: true }, context);
  assert.equal(out.data.openclaw_status, null);
  assert.doesNotThrow(() => assertSafeAgentProjection(out, { chatType: 'p2p', purpose: 'job_action' }));
  db.close();
});

test('建群工具（specs/017）：底层 blocker 错误码原样透出，不被吞成 INTERNAL', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' LIMIT 1`).get().project_id;
  const handlers = createActionToolHandlers({ db, launchProjectFn: async () => {
    throw Object.assign(new Error('no membership'), { code: 'PROJECT_MEMBERSHIP_REQUIRED' });
  } });
  await assert.rejects(() => handlers.brainx_launch_project_chat({ job_id: jobId, confirm: true },
    { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } }), /PROJECT_MEMBERSHIP_REQUIRED/);
  db.close();
});

test('重复接单（不同幂等键）按已接单优雅返回，不再报 INVALID_ARGUMENT', () => {
  // 2026-09-16 york/JLPJBV9 实证：launch 流程已接单后，旧卡片「接单」按钮再点撞 409。
  const { db, jobId, handlers, searches, context } = fixture();
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const first = handlers.brainx_accept_job({ job_id: jobId, due_at: due,
    idempotency_key: 'agent:accept:dup-1', confirm: true }, context);
  assert.equal(first.data.state, 'ACCEPTED');
  const second = handlers.brainx_accept_job({ job_id: jobId, due_at: due,
    idempotency_key: 'agent:accept:dup-2', confirm: true }, context);
  assert.equal(second.data.state, 'ACCEPTED');
  assert.equal(second.data.already, true, '重复接单按幂等成功返回');
  assert.ok(second.unknowns.some((u) => u.includes('已经在接了')));
  assert.equal(searches.length, 0, '接单与重复接单都不应触发搜索');
  db.close();
});
