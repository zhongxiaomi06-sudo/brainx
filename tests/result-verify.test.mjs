import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { verifyOpenmaiBatch, aggregateVerdicts } from '../src/result-verify.js';
import { buildOpenmaiDeliveryCard } from '../src/sourcing-result-card.js';
import { readCompiledCriteria } from '../src/criteria-compile.js';
import { emitEvent } from '../src/hub/emit.js';

function seededDb() {
  const db = openDb(':memory:');
  const at = now();
  db.prepare(`INSERT INTO sync_runs
    (sync_id,consultant_id,source,as_of,rows_expected,rows_read,complete,errors,input_hash,started_at,completed_at)
    VALUES ('sync-v','felix','test',?,1,1,1,'[]','hash',?,?)`).run(at, at, at);
  db.prepare(`INSERT INTO job_facts
    (project_id,company,role,city,active_state,captured_at,sync_id,raw_json,updated_at)
    VALUES ('P-VERIFY','测试公司','测试岗位','北京市','OPEN',?,'sync-v','{}',?)`).run(at, at);
  return db;
}

/** 落一条 B 层编译事件（S3 的输入）。 */
function seedCompiled(db, projectId, { hard = [], exclusions = [] } = {}) {
  emitEvent(db, {
    event_type: 'criteria.compiled',
    idem_key: `criteria:compiled:${projectId}:r1`,
    actor: 'system:criteria-compile',
    case_id: projectId,
    payload: {
      project_id: projectId, round: 1, criteria_source: 'llm_compiled',
      criteria_text: '判据文本', compiled: { role_focus: '岗位', hard_requirements: hard,
        preferences: [], exclusions, years_range: null, city_override: null, city_source: null },
    },
  });
}

function candidatesBlock(list) {
  return `本轮推荐如下\n<!-- BRAINX_CANDIDATES_V1 ${JSON.stringify({ candidates: list })} -->`;
}

const cand = (ref, name, role, evaluation, extra = {}) => ({
  candidate_ref: ref, name, role, experience: extra.experience || '7 年',
  city: extra.city || '北京', education: extra.education || '本科',
  evaluation, score: extra.score || '90%', ...extra,
});

/** verdict map → mock chatJson（对每个 ref 按给定判定返回 checks）。 */
function verifyDeps(refVerdicts, requirementsOfBatch, calls = []) {
  return {
    calls,
    isLlmConfigured: () => true,
    chatJson: async (system, user) => {
      calls.push({ system, user });
      const verdicts = Object.entries(refVerdicts).map(([ref, verdict]) => ({
        candidate_ref: ref,
        checks: (requirementsOfBatch || []).map((r) => ({
          requirement: r, verdict: typeof verdict === 'string' ? verdict : verdict[r] || 'unknown',
        })),
      }));
      return { verdicts };
    },
  };
}

/** 从卡片按展示顺序取候选人行文本（跳过表头行）。 */
function cardCandidateTexts(card) {
  return card.elements
    .filter((e) => e.tag === 'column_set' && e.columns?.[0]?.elements?.[0])
    .slice(1)
    .map((e) => {
      const el = e.columns[0].elements[0];
      return el.text?.content || '';
    });
}

function cardCandidateInfos(card) {
  return card.elements
    .filter((e) => e.tag === 'column_set' && e.columns?.[1]?.elements?.[0]?.content)
    .map((e) => e.columns[1].elements[0].content);
}

const CARD_JOB = { project_id: 'P-VERIFY', company: '测试公司', role: '测试岗位', search_round: 1 };

/* ---------- C1：JWH6Q57 回放（大厂背景应在「忌讳大厂」下沉底） ---------- */
test('C1 JWH6Q57 回放：大厂人 warn 沉底，顶部计数正确', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['忌讳仅有大厂经历'] });
  const list = [
    cand('PL0000000001', '胥欣', '字节跳动 产品运营', '字节跳动 5 年增长运营'),
    cand('PL0000000002', '王五', '创业公司 增长负责人', '0-1 增长操盘，无大厂经历'),
    cand('PL0000000003', '姜灿', '百度 产品经理', '百度 6 年'),
  ];
  const reqs = ['忌讳仅有大厂经历'];
  const deps = verifyDeps({
    PL0000000001: 'warn', PL0000000002: 'pass', PL0000000003: 'warn',
  }, reqs);
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) }, deps);
  assert.ok(!result.skipped, `不跳过：${JSON.stringify(result)}`);
  assert.equal(result.total, 3);
  assert.equal(result.passCount, 1);
  assert.equal(result.warnCount, 2);
  // 卡片重排：pass（王五）置顶，warn 沉底
  const card = buildOpenmaiDeliveryCard({ job: CARD_JOB, status: 'done', publicBaseUrl: 'https://base.yorkteam.cn/',
    resultText: candidatesBlock(list), source: 'supermai', verification: result });
  const texts = cardCandidateTexts(card).join('|');
  assert.ok(texts.indexOf('王五') < texts.indexOf('胥欣'), 'pass 置顶');
  assert.ok(texts.indexOf('王五') < texts.indexOf('姜灿'), 'warn 沉底');
  const infos = cardCandidateInfos(card).join('\n');
  assert.ok(infos.includes('⚠️ 未通过 JD 必备项：忌讳仅有大厂经历'), 'warn 行标注冲突条目');
  const note = JSON.stringify(card.elements).includes('JD 必备项校验：1/3 通过');
  assert.ok(note, '顶部 N/M 计数');
  db.close();
});

/* ---------- C2：J3ZJYBB 回放（投放岗 warn，真销售 pass 置顶） ---------- */
test('C2 J3ZJYBB 回放：投放优化岗 warn，广告销售 pass 置顶', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', {
    hard: ['广告主资源（品牌方/效果代理/MCN）'],
    exclusions: ['采购/IP引入背景（不能替代销售）'],
  });
  const list = [
    cand('PL1000000001', '投放甲', '某媒体 广告优化师', '信息流投放优化 5 年'),
    cand('PL1000000002', '投放乙', '某代理 优化师', 'sem 投放'),
    cand('PL1000000003', '销售丙', '谷歌广告 大客户销售经理', '广告主客户开拓与回款'),
  ];
  const reqs = ['广告主资源（品牌方/效果代理/MCN）', '采购/IP引入背景（不能替代销售）'];
  const deps = verifyDeps({
    PL1000000001: { '广告主资源（品牌方/效果代理/MCN）': 'warn', '采购/IP引入背景（不能替代销售）': 'unknown' },
    PL1000000002: { '广告主资源（品牌方/效果代理/MCN）': 'warn', '采购/IP引入背景（不能替代销售）': 'unknown' },
    PL1000000003: 'pass',
  }, reqs);
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) }, deps);
  assert.equal(result.passCount, 1);
  assert.equal(result.warnCount, 2);
  const card = buildOpenmaiDeliveryCard({ job: CARD_JOB, status: 'done', publicBaseUrl: 'https://base.yorkteam.cn/',
    resultText: candidatesBlock(list), source: 'supermai', verification: result });
  const texts = cardCandidateTexts(card).join('|');
  assert.ok(texts.startsWith('1. 销售丙'), `真销售置顶：${texts}`);
  db.close();
});

/* ---------- C3：JWZSVXQ 对照组回放（不误伤） ---------- */
test('C3 JWZSVXQ 对照组回放：≥8/10 pass，排序不变（不误伤）', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['出海/海外 UA 投放实操（Meta/Google/TikTok）'] });
  const list = Array.from({ length: 10 }, (_, i) =>
    cand(`PL20000000${String(i).padStart(2, '0')}`, `候选人${i + 1}`,
      'UA 投放经理', `海外 UA 投放 ${5 + (i % 3)} 年，Meta/Google/TikTok 实操`));
  const reqs = ['出海/海外 UA 投放实操（Meta/Google/TikTok）'];
  const refVerdicts = {};
  for (const c of list) refVerdicts[c.candidate_ref] = 'pass';
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) }, verifyDeps(refVerdicts, reqs));
  assert.equal(result.passCount, 10, '全员 pass（对照组不误伤）');
  const card = buildOpenmaiDeliveryCard({ job: CARD_JOB, status: 'done', publicBaseUrl: 'https://base.yorkteam.cn/',
    resultText: candidatesBlock(list), source: 'supermai', verification: result });
  const texts = cardCandidateTexts(card);
  assert.deepEqual(texts.map((t) => t.replace(/^\d+\. /, '')),
    list.map((c) => c.name), '全 pass 时保持引擎原序');
  db.close();
});

/* ---------- C4/C5/C6/C7/C8 ---------- */
test('C4 无 B 层结构化判据 → 跳过校验（agent 路径不受影响）', async () => {
  const db = seededDb(); // 无 criteria.compiled 事件
  const list = [cand('PL3000000001', '张三', '岗位', '评价')];
  const deps = verifyDeps({ PL3000000001: 'pass' }, ['x']);
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) }, deps);
  assert.equal(result.skipped, 'no_requirements');
  assert.equal(deps.calls.length, 0, '无判据不得调用 LLM');
  db.close();
});

test('C4b rules 兜底事件（无 compiled）同样跳过', async () => {
  const db = seededDb();
  emitEvent(db, {
    event_type: 'criteria.compiled',
    idem_key: 'criteria:compiled:P-VERIFY:r1', actor: 't', case_id: 'P-VERIFY',
    payload: { project_id: 'P-VERIFY', criteria_source: 'rules', criteria_text: '规则判据', compiled: null },
  });
  const result = await verifyOpenmaiBatch(db, { projectId: 'P-VERIFY',
    resultText: candidatesBlock([cand('PL3000000001', '张三', '岗位', '评价')]) },
  verifyDeps({}, []));
  assert.equal(result.skipped, 'no_requirements');
  db.close();
});

test('C5 全员 warn：不剔除、不空手而归，卡片如实标 0/N', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['必备A'] });
  const list = [
    cand('PL4000000001', '甲', '岗位', '评价'),
    cand('PL4000000002', '乙', '岗位', '评价'),
  ];
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) },
    verifyDeps({ PL4000000001: 'warn', PL4000000002: 'warn' }, ['必备A']));
  assert.equal(result.warnCount, 2);
  const card = buildOpenmaiDeliveryCard({ job: CARD_JOB, status: 'done', publicBaseUrl: 'https://base.yorkteam.cn/',
    resultText: candidatesBlock(list), source: 'supermai', verification: result });
  assert.equal(cardCandidateTexts(card).length, 2, 'warn 不剔除');
  assert.ok(JSON.stringify(card.elements).includes('JD 必备项校验：0/2 通过'));
  db.close();
});

test('C6 BRAINX_RESULT_VERIFY=0 → 跳过校验', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['必备A'] });
  process.env.BRAINX_RESULT_VERIFY = '0';
  try {
    const result = await verifyOpenmaiBatch(db, { projectId: 'P-VERIFY',
      resultText: candidatesBlock([cand('PL5000000001', '张三', '岗位', '评价')]) },
    verifyDeps({}, []));
    assert.equal(result.skipped, 'disabled');
  } finally {
    delete process.env.BRAINX_RESULT_VERIFY;
  }
  db.close();
});

test('C7 校验 LLM 失败 → 原序投递 + 「校验未执行」标注，不阻塞投递链路', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['必备A'] });
  const list = [
    cand('PL6000000001', '甲', '岗位', '评价甲'),
    cand('PL6000000002', '乙', '岗位', '评价乙'),
  ];
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) },
    { isLlmConfigured: () => true, chatJson: async () => { throw new Error('LLM HTTP 504'); } });
  assert.equal(result.skipped, 'llm_failed');
  // 卡片原序 + 校验未执行标注
  const card = buildOpenmaiDeliveryCard({ job: CARD_JOB, status: 'done', publicBaseUrl: 'https://base.yorkteam.cn/',
    resultText: candidatesBlock(list), source: 'supermai', verification: result });
  const texts = cardCandidateTexts(card);
  assert.equal(texts.length, 2, '原序投递不剔除');
  assert.ok(texts[0].includes('甲') && texts[1].includes('乙'), '保持引擎原序');
  assert.ok(JSON.stringify(card.elements).includes('未完成 JD 必备项校验'), '校验未执行标注');
  db.close();
});

test('C7b LLM 输出不合规（覆盖不足）→ 按 llm_failed 跳过', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['必备A'] });
  const list = Array.from({ length: 4 }, (_, i) =>
    cand(`PL700000000${i + 1}`, `候选人${i + 1}`, '岗位', '评价'));
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) },
    { isLlmConfigured: () => true, chatJson: async () => ({ verdicts: [] }) });
  assert.equal(result.skipped, 'llm_failed');
  db.close();
});

test('C8 无候选人批次（needs_input/空结果）不进校验', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['必备A'] });
  const deps = verifyDeps({}, []);
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: '请补充职位方向' }, deps);
  assert.equal(result.skipped, 'no_candidates');
  assert.equal(deps.calls.length, 0);
  db.close();
});

test('C10 warn 沉底不剔除：顾问手动初筛不受限（卡片仅影响展示）', async () => {
  const db = seededDb();
  seedCompiled(db, 'P-VERIFY', { hard: ['必备A'] });
  const list = [cand('PL8000000001', '甲', '岗位', '评价'), cand('PL8000000002', '乙', '岗位', '评价')];
  const result = await verifyOpenmaiBatch(db,
    { projectId: 'P-VERIFY', resultText: candidatesBlock(list) },
    verifyDeps({ PL8000000001: 'warn', PL8000000002: 'pass' }, ['必备A']));
  const card = buildOpenmaiDeliveryCard({ job: CARD_JOB, status: 'done', publicBaseUrl: 'https://base.yorkteam.cn/',
    resultText: candidatesBlock(list), source: 'supermai', verification: result });
  // 两人的初筛按钮都在（warn 不剥夺操作权）——只数按钮文案，不数指令文本里的「已初筛通过」
  const buttons = JSON.stringify(card.elements);
  assert.equal((buttons.match(/"content":"初筛通过"/g) || []).length, 2, 'warn 者操作按钮保留');
  db.close();
});

test('C-纯函数 aggregateVerdicts：unknown 为主时不误判 pass', () => {
  // 直调纯函数时传 camelCase（extractOpenmaiCandidates 的产物形状）
  const candidates = [{ candidateRef: 'PL1' }, { candidateRef: 'PL2' }];
  const byRef = new Map([
    ['PL1', [{ requirement: '必备A', verdict: 'unknown' }, { requirement: '必备B', verdict: 'unknown' }]],
    ['PL2', [{ requirement: '必备A', verdict: 'pass' }, { requirement: '必备B', verdict: 'warn' }]],
  ]);
  const v = aggregateVerdicts(candidates, byRef);
  assert.equal(v.PL1.verdict, 'unknown', '全 unknown → unknown');
  assert.equal(v.PL2.verdict, 'warn', '任一 warn → warn');
  assert.deepEqual(v.PL2.failed, ['必备B']);
});
