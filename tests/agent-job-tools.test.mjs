import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { createJobToolHandlers } from '../src/agent-gateway/tools-jobs.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  recommend(db, 'felix', { top: 5 });
  const projectId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  return { db, projectId, handlers: createJobToolHandlers({ db }) };
}

const context = (consultantId = 'felix', purpose = 'job_review') => ({
  principal: { tenantId: 'tenant-a', consultantId, chatType: 'p2p', purpose },
  runId: 'run-current', requestId: 'req-current',
});

test('me context 与 daily brief 只读取当前顾问并提供证据/未知', async () => {
  const { db, handlers } = fixture();
  const before = db.prepare('SELECT COUNT(*) n FROM decision_events').get().n;
  const me = await handlers.brainx_me_context({}, context('felix', 'self_context'));
  assert.equal(me.data.consultant_ref, 'self');
  assert.equal(me.data.display_name, 'Felix 黄鑫');
  const brief = await handlers.brainx_daily_brief({ limit: 3 }, context('felix', 'daily_brief'));
  assert.ok(brief.facts.length > 0);
  assert.ok(brief.facts.length <= 3);
  assert.ok(brief.evidence_refs.length > 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM decision_events').get().n, before, 'Agent 工具不得写业务事件');
});

test('job assessment 复用职位可见性并分开事实、推断和建议', async () => {
  const { handlers, projectId } = fixture();
  const result = await handlers.brainx_job_assessment({ job_id: projectId }, context());
  assert.equal(result.data.job.project_id, projectId);
  assert.ok(result.facts.length >= 1);
  assert.ok(Array.isArray(result.inferences));
  assert.ok(Array.isArray(result.recommendations));
  assert.ok(result.evidence_refs.some((ref) => ref.startsWith('job_fact:')));
  assert.throws(() => handlers.brainx_job_assessment({ job_id: projectId }, context('mia')), /NOT_FOUND_OR_FORBIDDEN/);
});

test('职位缺口问题最多三条且只针对真实缺失字段', async () => {
  const { db, handlers, projectId } = fixture();
  db.prepare('UPDATE job_facts SET city=NULL, hc=NULL, pipeline=NULL WHERE project_id=?').run(projectId);
  const result = await handlers.brainx_gap_questions({ object_type: 'job', object_ref: projectId }, context());
  assert.deepEqual(result.data.questions.map((item) => item.field), ['city', 'hc', 'pipeline']);
  assert.equal(result.data.questions.length, 3);
  assert.equal(result.inferences.length, 0);
});

test('personal review 按本人和日期窗口聚合，不返回他人明细', async () => {
  const { handlers } = fixture();
  const result = await handlers.brainx_personal_review({
    date_from: '2026-01-01', date_to: '2026-12-31',
  }, context('felix', 'personal_review'));
  assert.equal(result.data.consultant_ref, 'self');
  assert.ok(Number.isInteger(result.data.events));
  assert.ok(Number.isInteger(result.data.outcomes));
  assert.equal(JSON.stringify(result).includes('consultant_id'), false);
});

test('run status 只能读取本人 Agent run 或持久任务', async () => {
  const { db, handlers } = fixture();
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO integration_jobs
    (job_id, tenant_id, consultant_id, kind, idempotency_key, status, payload_json,
     requested_at, updated_at) VALUES ('job-run','tenant-a','felix','SEARCH','idem-run','PENDING','{}',?,?)`).run(at, at);
  const own = await handlers.brainx_run_status({ run_id: 'job-run' }, context('felix', 'run_status'));
  assert.equal(own.data.status, 'PENDING');
  assert.throws(() => handlers.brainx_run_status({ run_id: 'job-run' }, context('mia', 'run_status')), /NOT_FOUND_OR_FORBIDDEN/);
});

test('OpenMai done 结果返回带 present_result 呈现指引，不能只回「已就绪」', async () => {
  const { db, projectId, handlers } = fixture();
  // 接单写 ACCEPTED 事件（stub 启动函数，避免真网络），随后手工落一条 done 结果
  const action = createActionToolHandlers({ db, startSearchFn: () => ({ status: 'triggered', task_id: 'stub' }) });
  action.brainx_accept_job({ job_id: projectId, goal: '找到候选人', action_title: '启动找人',
    due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    idempotency_key: 'agent:om:accept', confirm: true }, context('felix', 'job_review'));
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?)`)
    .run(projectId, 'felix', 'done', '# 候选人\n1. 张三｜上海｜5年招聘经验\n2. 李四｜北京｜3年', 'om_omtest', at, at);

  const out = await handlers.brainx_openmai_search({ job_id: projectId }, context('felix', 'job_review'));
  assert.equal(out.data.status, 'done');
  assert.ok(out.data.result_text.includes('张三'), 'done 结果必须把 result_text 原样带出');
  assert.ok(out.recommendations.some((r) => r.action === 'present_result' && r.note.includes('完整')),
    'done 分支必须带 present_result 指引，防止模型只回“已就绪”不交付候选人');
  assert.equal(out.unknowns.length, 0);
});
