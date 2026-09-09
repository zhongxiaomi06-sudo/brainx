import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { setProjectCandidateFocus } from '../src/candidate-focus.js';
import { createTalentToolHandlers } from '../src/agent-gateway/tools-talent.js';

const ISO = '2026-09-03T08:00:00.000Z';
const principal = (chatType = 'p2p', purpose = 'candidate_review') => ({
  principal: { tenantId: 'tenant-a', consultantId: 'mia', chatType, purpose },
});

const item = {
  candidate_ref: 'cand-a', display_name_masked: '张*', rank: 1,
  profile: { current_city: '上海', recent_experiences: [{ company: '示例科技', title: '招聘经理', start_date: '2022-01', end_date: null, is_current: true, summary: '完成技术岗位招聘' }], education: [], skills: ['招聘'] },
  strength: { score: 82, summary: '交付经历完整', evidence_refs: ['ev-work'] },
  job_fit: { score: 78, summary: '方向匹配', evidence_refs: ['ev-work'] },
  hard_conditions: [{ criterion: '上海', result: 'PASS', evidence_refs: ['ev-city'] }],
  gaps: ['团队规模待确认'], risks: ['行业跨度'], unknowns: ['到岗时间'],
  data_freshness: { fact_processed_at: ISO, status: 'FRESH' },
};

const bundle = {
  schema_version: 'candidate_match_bundle_v1', job_ref: 'job-a',
  job_context: { title: 'HR 经理', summary: null, experience_requirement: '5年', education_requirement: null,
    location: '上海', required_skills: ['招聘'], preferred_skills: [], responsibilities: [], unknowns: ['薪资范围未提供'] },
  match_run: { match_run_id: 'match-run-a', algorithm_version: 'production-v1', feature_schema_version: 'features-v1', completed_at: ISO },
  page: { limit: 5, next_page_token: null }, items: [item],
  data_scope: { scope: 'authorized_shortlist', purpose: 'candidate_review' }, generated_at: ISO,
};

const fact = {
  schema_version: 'candidate_fact_v1', fact_version_id: 'fact-a', candidate_ref: 'cand-a',
  document: { document_ref: 'doc-a', source_format: 'legacy_text', content_hash: 'a'.repeat(64), parser_version: 'v1', processed_at: ISO },
  identity: { display_name: '张三', contact_ref: 'contact-private', current_city: '上海', evidence_refs: ['ev-name'] },
  work_experiences: [{ company: '示例科技', title: '招聘经理', start_date: '2022-01', end_date: null, is_current: true,
    summary: '完成技术岗位招聘', achievements: [], evidence_refs: ['ev-work'] }],
  education: [], skills: [{ name: '招聘', normalized_name: '招聘', proficiency: 'EXPLICIT', evidence_refs: ['ev-skill'] }],
  constraints: [{ name: 'availability', value: null, state: 'UNKNOWN', evidence_refs: [] }],
  evidence: [
    { evidence_ref: 'ev-name', field_path: 'identity.display_name', source_ref: 'doc-a', excerpt_hash: 'a'.repeat(64) },
    { evidence_ref: 'ev-work', field_path: 'work_experiences.0', source_ref: 'doc-a', excerpt_hash: 'a'.repeat(64) },
    { evidence_ref: 'ev-skill', field_path: 'skills.0', source_ref: 'doc-a', excerpt_hash: 'a'.repeat(64) },
  ], quality: { status: 'READY', evidence_coverage: 0.8, unknown_fields: ['availability'], warnings: [] },
};

function handlers(calls = []) {
  return createTalentToolHandlers({
    candidateShortlistFn: async (input) => {
      calls.push(input);
      return { ...bundle, data_scope: { ...bundle.data_scope, purpose: input.purpose } };
    },
    loadCandidateFactFn: async (input) => { calls.push(input); return fact; },
    loadCandidateContactFn: async (input) => { calls.push(input); return { phone: '13800138000', email: 'candidate@example.com' }; },
  });
}

test('候选联系方式走独立读取器并保留访问理由', async () => {
  const calls = [];
  const out = await handlers(calls).brainx_candidate_contact({ candidate_ref: 'cand-a', reason: '联系前确认' },
    principal('p2p', 'candidate_contact'));
  assert.equal(out.data.contact.phone, '13800138000');
  assert.equal(calls[0].consultantId, 'mia');
});

test('shortlist 从可信 principal 注入范围，群聊上限三人', async () => {
  const calls = [];
  const out = await handlers(calls).brainx_candidate_shortlist({ job_id: 'job-a', limit: 5 }, principal('group'));
  assert.equal(calls[0].tenantId, 'tenant-a');
  assert.equal(calls[0].consultantId, 'mia');
  assert.equal(calls[0].limit, 3);
  assert.equal(out.inferences[0].strength_score, 82);
  assert.equal(out.recommendations[0].candidate_ref, 'cand-a');
  assert.ok(out.evidence_refs.includes('match_run:match-run-a'));
});

test('shortlist 带回项目共享重点名单供后续群问答使用', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'TTC-KEEP-1', name: '李四', role: '未来科技 / 测试开发',
      evaluation: 'Python 与自动化经验匹配', score: '88%' },
  ] })}\n-->`;
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at)
    VALUES (?,?,'done',?,'om-focus','2026-09-09T00:00:00.000Z','2026-09-09T00:01:00.000Z')`)
    .run(jobId, 'felix', resultText);
  setProjectCandidateFocus(db, { tenantId: 'tenant-a', consultantId: 'felix', jobId,
    candidateRef: 'TTC-KEEP-1', sourceTaskId: 'om-focus', candidateSnapshot: {
      name: '李四', role: '未来科技 / 测试开发', experience: '7 年', city: '北京',
      education: '本科', evaluation: 'Python 与自动化经验匹配', score: '88%',
    } }, true, '2026-09-09T00:02:00.000Z');
  db.prepare("UPDATE openmai_results SET result_text='下一轮没有该候选人' WHERE task_id='om-focus'").run();
  const api = createTalentToolHandlers({ db, candidateShortlistFn: async (input) => ({
    ...bundle, job_ref: jobId, items: [], match_run: null,
    data_scope: { ...bundle.data_scope, purpose: input.purpose },
  }) });
  const out = await api.brainx_candidate_shortlist({ job_id: jobId }, principal('group'));
  assert.deepEqual(out.data.focused_candidates, [{
    candidate_ref: 'TTC-KEEP-1', name: '李四', role: '未来科技 / 测试开发',
    experience: '7 年', city: '北京', education: '本科',
    evaluation: 'Python 与自动化经验匹配', score: '88%', source_task_id: 'om-focus',
    focused_at: '2026-09-09T00:02:00.000Z',
  }]);
  assert.ok(out.facts.some((entry) => entry.kind === 'focused_candidate'));
  assert.ok(out.evidence_refs.includes(`candidate_focus:${jobId}:TTC-KEEP-1`));
  db.close();
});

test('candidate facts 只投影结构化事实，不返回姓名、contact_ref、hash 或原文', async () => {
  const out = await handlers().brainx_candidate_facts({ candidate_ref: 'cand-a', purpose: 'candidate_review' }, principal());
  const serialized = JSON.stringify(out);
  assert.equal(out.data.display_name_masked, '张*');
  assert.doesNotMatch(serialized, /张三|contact-private|content_hash|resume_raw/);
  assert.equal(out.source_versions.candidate_fact, 'fact-a');
  assert.ok(out.evidence_refs.includes('ev-work'));
});

test('candidate fit 保持实力分与本职位匹配分分离并固定 run 版本', async () => {
  const out = await handlers().brainx_candidate_fit({ job_id: 'job-a', candidate_ref: 'cand-a' }, principal());
  assert.equal(out.data.strength.score, 82);
  assert.equal(out.data.job_fit.score, 78);
  assert.equal(out.data.match_run.match_run_id, 'match-run-a');
  assert.equal(out.facts[0].hard_filter_result, 'PASS');
});

test('候选缺口与面试准备最多分别三条和十二条，问题能回指证据或未知', async () => {
  const api = handlers();
  const gaps = await api.brainx_gap_questions({ object_type: 'candidate', object_ref: 'cand-a' }, principal());
  assert.ok(gaps.data.questions.length <= 3);
  assert.ok(gaps.data.questions.some((question) => question.field === 'availability'));
  const prep = await api.brainx_interview_prep({ job_id: 'job-a', candidate_ref: 'cand-a' }, principal('p2p', 'interview_prep'));
  assert.ok(prep.data.questions.length > 0 && prep.data.questions.length <= 12);
  assert.ok(prep.evidence_refs.includes('match_run:match-run-a'));
});

test('授权源失败原样返回稳定错误码，不把空数据伪装为无候选人', async () => {
  const error = Object.assign(new Error('private SQL'), { code: 'SOURCE_UNAVAILABLE' });
  const api = createTalentToolHandlers({ candidateShortlistFn: async () => { throw error; } });
  await assert.rejects(() => api.brainx_candidate_shortlist({ job_id: 'job-a' }, principal()), (caught) => {
    assert.equal(caught.code, 'SOURCE_UNAVAILABLE');
    return true;
  });
});

// —— 空 shortlist 溯源引导（2026-09-04 wendy 案例回归）——
// 内部短名单（RDS reloop 旁路）只覆盖部分合作岗位；该岗位候选人可能由 OpenMai
// 找人异步产生并存于 openmai_results。空结果必须引导模型走 openmai_search 取回，
// 不能回成「找不到人 / 数据源挂了」。

function emptyGuidanceDb(openmaiRow, engagedRow) {
  return {
    prepare: (sql) => ({
      all: () => [],
      get: () => {
        if (sql.includes('openmai_results')) return openmaiRow;
        if (sql.includes('decision_events')) return engagedRow;
        return undefined;
      },
    }),
  };
}

function emptyShortlistApi(db) {
  return createTalentToolHandlers({
    db,
    candidateShortlistFn: async (input) => ({
      schema_version: 'candidate_match_bundle_v1', job_ref: 'job-a',
      job_context: { title: 'HR 经理', summary: null, experience_requirement: '5年', education_requirement: null,
        location: '上海', required_skills: [], preferred_skills: [], responsibilities: [], unknowns: [] },
      match_run: null, page: { limit: 5, next_page_token: null }, items: [],
      data_scope: { scope: 'authorized_shortlist', purpose: input.purpose }, generated_at: ISO,
    }),
  });
}

test('空 shortlist + openmai done：指引用 openmai_search 取回呈现，不宣称无候选人', async () => {
  const api = emptyShortlistApi(emptyGuidanceDb({ status: 'done' }, undefined));
  const out = await api.brainx_candidate_shortlist({ job_id: 'job-a' }, principal());
  assert.equal(out.data.items.length, 0);
  assert.ok(out.unknowns.some((u) => u.includes('brainx_openmai_search') && u.includes('done')));
});

test('空 shortlist + 找人进行中：给出进行中提示与取回入口', async () => {
  const api = emptyShortlistApi(emptyGuidanceDb({ status: 'running' }, { 1: 1 }));
  const out = await api.brainx_candidate_shortlist({ job_id: 'job-a' }, principal());
  assert.ok(out.unknowns.some((u) => u.includes('brainx_openmai_search')));
  assert.ok(out.unknowns.some((u) => u.includes('running')));
});

test('空 shortlist + 无找人记录：提示先接单触发，而非臆断数据源故障', async () => {
  const api = emptyShortlistApi(emptyGuidanceDb(undefined, undefined));
  const out = await api.brainx_candidate_shortlist({ job_id: 'job-a' }, principal());
  assert.ok(out.unknowns.some((u) => u.includes('接单')));
  assert.equal(out.unknowns.some((u) => u.includes('稍后重试')), false);
});

test('空 shortlist + 网关未注入 db：不崩溃、不新增臆断', async () => {
  const api = emptyShortlistApi(undefined);
  const out = await api.brainx_candidate_shortlist({ job_id: 'job-a' }, principal());
  assert.equal(out.data.items.length, 0);
  assert.equal(out.unknowns.length, 0);
});
