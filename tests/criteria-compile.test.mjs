import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { compileSearchCriteria, buildCriteriaText, readCompiledCriteria } from '../src/criteria-compile.js';
import { buildAutoSearchCriteria } from '../src/auto-search.js';

/** LLM「已配置」的依赖注入：chatJson 用 mock，isLlmConfigured 恒 true。 */
function llmDeps(reply, calls = []) {
  return {
    calls,
    isLlmConfigured: () => true,
    chatJson: async (system, user, opts) => {
      calls.push({ system, user, opts });
      if (reply instanceof Error) throw reply;
      return typeof reply === 'function' ? reply(system, user) : reply;
    },
  };
}

function seededDb() {
  const db = openDb(':memory:');
  const at = now();
  db.prepare(`INSERT INTO sync_runs
    (sync_id,consultant_id,source,as_of,rows_expected,rows_read,complete,errors,input_hash,started_at,completed_at)
    VALUES ('sync-c','felix','test',?,1,1,1,'[]','hash',?,?)`).run(at, at, at);
  db.prepare(`INSERT INTO job_facts
    (project_id,company,role,city,hc,active_state,captured_at,sync_id,raw_json,updated_at)
    VALUES ('P-CRITERIA','测试公司','测试岗位','北京市',1,'OPEN',?,'sync-c','{}',?)`).run(at, at);
  return db;
}

const JWH6Q57_JOB = {
  role: 'AI产品运营增长-toc', city: '北京市', hc: 1, company: '北京耳朵时间科技有限公司',
  notes: '3-8年工作经验【必须项】。0-1产品增长运营背景。目标公司不限，但忌讳仅有大厂经历。30岁以内优先。',
};

test('B1 JWH6Q57：编译含客户禁忌 + 真实年限 + 无年龄条件', async () => {
  const db = seededDb();
  const compiledReply = {
    role_focus: 'AI产品运营增长（toc 向，0-1 增长运营背景）',
    hard_requirements: ['忌讳仅有大厂经历（缺乏落地能力）', '0-1 产品增长运营背景'],
    preferences: [], exclusions: [],
    years_range: '3-8', city_override: null, city_source: null,
  };
  const out = await compileSearchCriteria(db, JWH6Q57_JOB,
    { projectId: 'P-CRITERIA', dependencies: llmDeps(compiledReply) });
  assert.equal(out.criteria_source, 'llm_compiled');
  assert.ok(out.criteria.includes('忌讳仅有大厂经历'), '客户禁忌入判据');
  assert.ok(out.criteria.includes('3-8 年工作经验'), '真实年限优先');
  assert.ok(!out.criteria.includes('30岁'), '编译判据不得含年龄条件');
  db.close();
});

test('B2 J3ZJYBB：销售向语义 + 画像城市覆盖 + 排除项', async () => {
  const db = seededDb();
  const compiledReply = {
    role_focus: '商务BD-广告主资源（销售向：客户开拓/谈判/回款/销售指标）',
    hard_requirements: ['广告主资源（品牌方/效果代理/MCN）'],
    preferences: ['AIGC 行业了解'], exclusions: ['采购/IP引入背景（不能替代销售）'],
    years_range: '3-8', city_override: '广州', city_source: 'xiaomai_profile',
  };
  const out = await compileSearchCriteria(db, {
    role: '商业化运营/商务BD-广告主资源方向', city: '北京市、上海市', hc: 1,
    company: '上海天码形空科技有限公司（OiiOii）',
    notes: '独立开拓广告主客户资源，负责商务谈判、合同签订及回款跟进。小麦同步画像：工作地点为广州；销售职能不可被采购/IP引入替代。',
  }, { projectId: 'P-CRITERIA', dependencies: llmDeps(compiledReply) });
  // B10 顺带：画像城市（广州）优先于 city 字段（北京/上海）
  assert.ok(out.criteria.includes('广州'), '画像城市覆盖 city 字段');
  assert.ok(!out.criteria.includes('北京市、上海市'), '冲突的 city 字段不得同时出现');
  assert.ok(out.criteria.includes('排除：'), '排除项入判据');
  assert.equal(out.compiled.city_source, 'xiaomai_profile', '来源可追溯');
  db.close();
});

test('B3 JH46A56：无年限门槛不硬造，city 覆盖深圳', async () => {
  const db = seededDb();
  const compiledReply = {
    role_focus: 'Agent 软件技术负责人（搭建与管理研发团队）',
    hard_requirements: [], preferences: [],
    exclusions: ['纯 PM/纯产品视角'],
    years_range: null, city_override: '深圳', city_source: 'xiaomai_profile',
  };
  const out = await compileSearchCriteria(db, {
    role: 'Agent软件技术负责人', city: '北京市', hc: 1, company: 'Zettlab吾云创新',
    notes: '负责软件研发团队的搭建与管理。小麦同步画像：深圳优先；无年限门槛；不要纯 PM。',
  }, { projectId: 'P-CRITERIA', dependencies: llmDeps(compiledReply) });
  assert.ok(out.criteria.includes('3-5 年工作经验'), 'years_range=null 时兜底默认年限（不硬造）');
  assert.ok(out.criteria.includes('深圳'), '画像城市生效');
  assert.ok(out.criteria.includes('纯 PM/纯产品视角'), '排除项生效');
  db.close();
});

test('B4 LLM 输出夹带年龄/性别条件 → 出参正则剥除', async () => {
  const db = seededDb();
  const compiledReply = {
    role_focus: '增长运营（35岁以下优先）',
    hard_requirements: ['0-1 增长背景', '30岁以内', '女生优先'],
    preferences: [], exclusions: [],
    years_range: null, city_override: null, city_source: null,
  };
  const out = await compileSearchCriteria(db, JWH6Q57_JOB,
    { projectId: 'P-CRITERIA', dependencies: llmDeps(compiledReply) });
  assert.ok(!out.criteria.includes('35岁'), 'role_focus 中的年龄条件剥除');
  assert.ok(!out.criteria.includes('30岁') && !out.criteria.includes('女生'), 'hard_requirements 中歧视条件剥除');
  assert.ok(out.criteria.includes('0-1 增长背景'), '正常条目保留');
  db.close();
});

test('B5 LLM 超时/抛错 → 落回 S1 判据，criteria_source=rules，留痕可查', async () => {
  const db = seededDb();
  const out = await compileSearchCriteria(db, JWH6Q57_JOB,
    { projectId: 'P-CRITERIA', dependencies: llmDeps(new Error('LLM HTTP 500')) });
  assert.equal(out.criteria_source, 'rules');
  assert.equal(out.criteria, buildAutoSearchCriteria(JWH6Q57_JOB), '规则判据兜底');
  // rules 兜底事件有 criteria_source 与 fallback_reason；无结构化 compiled（S3 读到 null 正确）
  const row = db.prepare(`SELECT payload FROM workflow_event_log WHERE event_type='criteria.compiled'`).get();
  const payload = JSON.parse(row.payload);
  assert.equal(payload.criteria_source, 'rules');
  assert.equal(payload.fallback_reason, 'llm_failed_or_invalid');
  assert.equal(readCompiledCriteria(db, 'P-CRITERIA'), null, 'rules 兜底无结构化判据，S3 跳过校验');
  db.close();
});

test('B6 notes 为空 → 不调 LLM 直接 S1', async () => {
  const db = seededDb();
  const calls = [];
  const deps = llmDeps({ role_focus: 'x' }, calls);
  const out = await compileSearchCriteria(db,
    { role: 'Java后端', city: '深圳', company: 'X公司' },
    { projectId: 'P-CRITERIA', dependencies: deps });
  assert.equal(out.criteria_source, 'rules');
  assert.equal(calls.length, 0, 'notes 为空不得发起 LLM 调用');
  db.close();
});

test('B7 BRAINX_CRITERIA_LLM=0 → 全程无 LLM 调用', async () => {
  const db = seededDb();
  const calls = [];
  const deps = llmDeps({ role_focus: 'x' }, calls);
  process.env.BRAINX_CRITERIA_LLM = '0';
  try {
    const out = await compileSearchCriteria(db, JWH6Q57_JOB,
      { projectId: 'P-CRITERIA', dependencies: deps });
    assert.equal(out.criteria_source, 'rules');
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.BRAINX_CRITERIA_LLM;
  }
  db.close();
});

test('B7b LLM 未配置 → 无调用直接规则（生产现状：isLlmConfigured()=false）', async () => {
  const db = seededDb();
  const calls = [];
  const deps = { ...llmDeps({ role_focus: 'x' }, calls), isLlmConfigured: () => false };
  const out = await compileSearchCriteria(db, JWH6Q57_JOB,
    { projectId: 'P-CRITERIA', dependencies: deps });
  assert.equal(out.criteria_source, 'rules');
  assert.equal(calls.length, 0);
  db.close();
});

test('B8 LLM 输出不合 schema → 落回 S1 不抛错不阻塞', async () => {
  const db = seededDb();
  for (const bad of ['不是JSON', { role_focus: '' , hard_requirements: [], preferences: [], exclusions: [] }, null, 42]) {
    const out = await compileSearchCriteria(db, JWH6Q57_JOB,
      { projectId: 'P-CRITERIA', dependencies: llmDeps(bad) });
    assert.equal(out.criteria_source, 'rules', `输入 ${JSON.stringify(bad)} 应落回规则`);
    assert.ok(out.criteria, '规则判据始终有值');
  }
  db.close();
});

test('B9 事件按 project+round 幂等，readCompiledCriteria 取最新', async () => {
  const db = seededDb();
  const reply = { role_focus: '岗位A', hard_requirements: ['必备X'], preferences: [],
    exclusions: [], years_range: null, city_override: null, city_source: null };
  await compileSearchCriteria(db, { role: 'R', city: 'C', company: 'X', notes: 'JD内容' },
    { projectId: 'P-CRITERIA', round: 1, dependencies: llmDeps(reply) });
  // 同 round 重复触发 → 幂等不重复入账
  await compileSearchCriteria(db, { role: 'R', city: 'C', company: 'X', notes: 'JD内容' },
    { projectId: 'P-CRITERIA', round: 1, dependencies: llmDeps(reply) });
  let count = db.prepare(`SELECT COUNT(*) c FROM workflow_event_log
    WHERE event_type='criteria.compiled' AND idem_key='criteria:compiled:P-CRITERIA:r1'`).get().c;
  assert.equal(count, 1, '同 project+round 幂等');
  const ev = readCompiledCriteria(db, 'P-CRITERIA');
  assert.equal(ev.criteria_source, 'llm_compiled');
  assert.deepEqual(ev.hard_requirements, ['必备X']);
  // 续搜轮（round 2）沿用首轮：调用方不重复编译，此处验证读取接口拿到的是 r1 产物
  assert.ok(readCompiledCriteria(db, 'P-CRITERIA').hard_requirements.length === 1);
  db.close();
});

test('B10 buildCriteriaText 总长 ≤1200 且包含全部结构段', () => {
  const compiled = {
    role_focus: 'r'.repeat(120),
    hard_requirements: Array.from({ length: 5 }, (_, i) => `硬性必备条件第${i + 1}条`.repeat(6)),
    preferences: Array.from({ length: 5 }, (_, i) => `偏好条件第${i + 1}条`.repeat(6)),
    exclusions: Array.from({ length: 5 }, (_, i) => `排除条件第${i + 1}条`.repeat(6)),
    years_range: '3-8', city_override: '广州', city_source: 'xiaomai_profile',
  };
  const text = buildCriteriaText(compiled, { city: '北京', hc: 3, company: '某公司' });
  assert.ok(text.length <= 1200, `总长 ${text.length} 不得超 1200`);
  assert.ok(text.includes('广州') && !text.includes('北京'), '城市覆盖');
  assert.ok(text.includes('必备：') && text.includes('优先：') && text.includes('排除：'));
});

test('B10b readCompiledCriteria：无事件/损坏 payload 返回 null', () => {
  const db = seededDb();
  assert.equal(readCompiledCriteria(db, 'P-NOPE'), null);
  db.prepare(`INSERT INTO workflow_event_log
    (event_id,idem_key,event_type,case_id,actor,occurred_at,payload,evidence_refs,schema_version)
    VALUES ('e1','k1','criteria.compiled','P-BAD','t',?,'not-json','[]',1)`).run(now());
  assert.equal(readCompiledCriteria(db, 'P-BAD'), null, '损坏 payload 不抛错');
  db.close();
});
