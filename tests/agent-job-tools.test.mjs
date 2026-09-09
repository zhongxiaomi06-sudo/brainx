import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { createJobToolHandlers } from '../src/agent-gateway/tools-jobs.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';
import { supermaiCriteriaKey } from '../src/supermai-sourcing.js';

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

test('OpenMai 项目入口接收可选找人条件并在无凭证时也如实留痕', () => {
  const { db, projectId, handlers } = fixture();
  const action = createActionToolHandlers({ db, startSearchFn: () => ({ status: 'triggered', task_id: 'stub' }) });
  action.brainx_accept_job({ job_id: projectId, goal: '找到候选人', action_title: '选择找人渠道',
    due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    idempotency_key: 'agent:om:criteria', confirm: true }, context('felix', 'job_review'));
  const out = handlers.brainx_openmai_search({
    job_id: projectId, criteria: '北京，必须有测试平台从零搭建经验',
  }, context('felix', 'candidate_review'));
  assert.equal(out.data.entry, 'openmai');
  assert.equal(out.data.status, 'error');
  assert.match(out.data.message, /TTC 寻访凭证/);
  assert.equal(db.prepare(`SELECT search_brief FROM openmai_results
    WHERE consultant_id='felix' AND project_id=?`).get(projectId).search_brief,
  '北京，必须有测试平台从零搭建经验');
});

test('SuperMai 项目入口留空时按职位生成判据并关联原项目群', () => {
  const { db, projectId, handlers } = fixture();
  const action = createActionToolHandlers({ db, startSearchFn: () => ({ status: 'triggered', task_id: 'stub' }) });
  action.brainx_accept_job({ job_id: projectId, goal: '找到候选人', action_title: '选择找人渠道',
    due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    idempotency_key: 'agent:sm:project', confirm: true }, context('felix', 'job_review'));
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,created_at,updated_at)
    VALUES ('launch-sm','felix',?,'launch-sm','READY','READY','oc_project',?,?)`).run(projectId, at, at);
  const out = handlers.brainx_supermai_scout({ job_id: projectId }, context('felix', 'candidate_review'));
  assert.equal(out.data.entry, 'supermai');
  assert.equal(out.data.job_ref, projectId);
  assert.equal(out.data.status, 'error');
  assert.match(out.data.criteria, /目标职位：/);
  const stored = db.prepare(`SELECT project_id,search_brief FROM openmai_results
    WHERE consultant_id='felix' AND project_id=?`).get(projectId);
  assert.equal(stored.project_id, projectId, '项目模式不使用脱离项目群的 supermai 合成键');
  assert.match(stored.search_brief, /目标职位：/);
  assert.equal(db.prepare('SELECT search_status FROM project_launches WHERE launch_id=?')
    .get('launch-sm').search_status, 'FAILED');
});

test('项目已有共享找人任务时另一位顾问选择渠道不会重复触发', () => {
  const { db, projectId, handlers } = fixture();
  const action = createActionToolHandlers({ db, startSearchFn: () => ({ status: 'triggered', task_id: 'stub' }) });
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO job_memberships
    (consultant_id,project_id,relation,source,valid_from)
    VALUES ('mia',?,'TEAM_SHARED','project_group',?)`).run(projectId, at);
  action.brainx_accept_job({ job_id: projectId, goal: '找到候选人', action_title: '选择找人渠道',
    due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    idempotency_key: 'agent:shared:project', confirm: true }, context('mia', 'job_review'));
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,
     search_status,search_task_id,created_at,updated_at)
    VALUES ('launch-running','felix',?,'launch-running','READY','READY','oc_project',
      'RUNNING','task-owner',?,?)`).run(projectId, at, at);
  const out = handlers.brainx_supermai_scout({ job_id: projectId }, context('mia', 'candidate_review'));
  assert.equal(out.data.status, 'running');
  assert.equal(out.data.shared, true);
  assert.equal(out.data.task_id, 'task-owner');
  assert.equal(db.prepare(`SELECT COUNT(*) count FROM openmai_results
    WHERE consultant_id='mia' AND project_id=?`).get(projectId).count, 0);
});

test('SuperMai 入口（specs/007）：done 结果带结构化 candidates + present_result 指引', async () => {
  const { db, handlers } = fixture();
  const criteria = '北京 5年 React 资深前端工程师';
  const key = supermaiCriteriaKey(criteria);
  const at = new Date().toISOString();
  const resultText = [
    '1. 王五｜Acme｜高级前端',
    '<!-- BRAINX_CANDIDATES_V1',
    '{"candidates":[{"candidate_ref":"c1","name":"王五","evaluation":"5年React","resume_url":null}]}',
    '-->',
  ].join('\n');
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?)`).run(key, 'felix', 'done', resultText, 'sm_test1', at, at);

  const out = await handlers.brainx_supermai_scout({ criteria }, context('felix', 'candidate_review'));
  assert.equal(out.data.entry, 'supermai');
  assert.equal(out.data.status, 'done');
  assert.equal(out.data.candidates.length, 1, '机器块解析为结构化 candidates');
  assert.equal(out.data.candidates[0].name, '王五');
  assert.ok(out.recommendations.some((r) => r.action === 'present_result'));
});

test('SuperMai 入口（specs/007）：无 TTC 凭证 → error + 引导语，不臆断成功', async () => {
  const { handlers } = fixture(); // fixture 库无 ttc_tokens
  const out = await handlers.brainx_supermai_scout(
    { criteria: '上海 3年 Java 后端工程师' }, context('felix', 'candidate_review'));
  assert.equal(out.data.status, 'error');
  assert.ok(out.data.message.includes('TTC 凭证'));
});

test('SuperMai 入口（specs/008）：NO_REPLY 零命中语义化为未搜到，不当成成功交付', async () => {
  const { db, handlers } = fixture();
  const criteria = '北京视界引擎科技 海外产品UI设计专家';
  const key = supermaiCriteriaKey(criteria);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?)`).run(key, 'felix', 'done', 'NO_REPLY', 'sm_zero', at, at);
  const out = await handlers.brainx_supermai_scout({ criteria }, context('felix', 'candidate_review'));
  assert.equal(out.data.status, 'done');
  assert.equal(out.data.result_text, null, 'NO_REPLY 不作为结果文本交付');
  assert.equal(out.data.empty_reason, 'NO_MATCHES_FOUND');
  assert.ok(out.unknowns.some((u) => u.includes('放宽判据')), '零命中要给出放宽判据建议');
  assert.equal(out.recommendations.length, 0, '零命中不出现 present_result');
});

test('找人任务 running/触发响应内嵌守候纪律（2026-09-09 事故：模型 2 分钟放弃+重试被禁工具）', async () => {
  const { db, handlers } = fixture();
  const criteria = '北京 5年 React 资深前端工程师';
  const key = supermaiCriteriaKey(criteria);
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, task_id, started_at)
    VALUES (?,?,?,?,?)`).run(key, 'felix', 'running', 'sm_wait', at);

  const running = await handlers.brainx_supermai_scout({ criteria }, context('felix', 'candidate_review'));
  assert.equal(running.data.status, 'running');
  const guard = running.unknowns.join('');
  assert.ok(guard.includes('3-5 分钟'), 'running 响应写明收敛时长');
  assert.ok(guard.includes('最多守候 10 分钟'), 'running 响应写明守候上限');
  assert.ok(guard.includes('不要尝试 read/exec'), 'running 响应禁止尝试被禁工具');

  // 触发响应同样带守候纪律
  db.prepare(`DELETE FROM openmai_results WHERE project_id=?`).run(key);
  const triggered = await handlers.brainx_supermai_scout({ criteria }, context('felix', 'candidate_review'));
  assert.ok(triggered.data.note.includes('3-5 分钟'), '触发响应写明收敛时长');
  assert.ok(triggered.data.note.includes('每隔约 1 分钟'), '触发响应写明轮询节奏');
});
