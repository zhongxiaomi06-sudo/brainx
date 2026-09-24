/** shortlist-card.test.mjs — 群里呈现候选人一律改标准卡片（代码确定性渲染）。
 * 覆盖：① 群 shortlist 发卡（行结构/按钮指令/幂等键/envelope 不列名单）；
 * ② 私聊不发卡；③ 发卡失败不阻断且 envelope 维持原样；
 * ④ openmai_search done 群读回发卡、running 不发、私聊不发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { createTalentToolHandlers } from '../src/agent-gateway/tools-talent.js';
import { createJobToolHandlers } from '../src/agent-gateway/tools-jobs.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';
import { buildShortlistCard } from '../src/shortlist-card.js';

const ISO = '2026-09-03T08:00:00.000Z';
const groupPrincipal = {
  principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'group',
    chatId: 'oc_group1', purpose: 'candidate_review' },
};
const p2pPrincipal = {
  principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p',
    purpose: 'candidate_review' },
};

const item = {
  candidate_ref: 'reloop-profile:31', display_name_masked: '张*', rank: 1,
  profile: { current_city: '上海',
    recent_experiences: [{ company: '示例科技', title: '招聘经理', start_date: '2022-01',
      end_date: null, is_current: true, summary: '完成技术岗位招聘' }],
    education: [{ school: '示例大学', degree: '本科' }], skills: ['招聘'] },
  strength: { score: 82, summary: '交付经历完整', evidence_refs: ['ev-work'] },
  job_fit: { score: 78, summary: '方向匹配', evidence_refs: ['ev-work'] },
  hard_conditions: [], gaps: [], risks: [], unknowns: [],
  data_freshness: { fact_processed_at: ISO, status: 'FRESH' },
};

const bundle = {
  schema_version: 'candidate_match_bundle_v1', job_ref: 'job-a',
  job_context: { title: 'HR 经理', summary: null, experience_requirement: null,
    education_requirement: null, location: '上海', required_skills: [], preferred_skills: [],
    responsibilities: [], unknowns: [] },
  match_run: { match_run_id: 'match-run-a', algorithm_version: 'production-v1',
    feature_schema_version: 'features-v1', completed_at: ISO },
  page: { limit: 3, next_page_token: null }, items: [item],
  data_scope: { scope: 'authorized_shortlist', purpose: 'candidate_review' }, generated_at: ISO,
};

function talentHandlers(sent, sendCardFn) {
  return createTalentToolHandlers({
    candidateShortlistFn: async (input) => (
      { ...bundle, data_scope: { ...bundle.data_scope, purpose: input.purpose } }),
    sendCardFn: sendCardFn || ((payload) => { sent.push(payload); return { message_id: 'om_x' }; }),
  });
}

const allButtons = (node, out = []) => {
  if (Array.isArray(node)) { node.forEach((child) => allButtons(child, out)); return out; }
  if (node && typeof node === 'object') {
    if (node.tag === 'button') out.push(node);
    Object.values(node).forEach((value) => allButtons(value, out));
  }
  return out;
};

test('群上下文 shortlist：卡片发出（行结构/按钮指令/幂等键），envelope 不再含名单', async () => {
  const sent = [];
  const out = await talentHandlers(sent).brainx_candidate_shortlist({ job_id: 'job-a' }, groupPrincipal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 'oc_group1');
  assert.match(sent[0].idempotencyKey, /^shortlist-card:job-a:oc_group1:first:\d{4}-\d{2}-\d{2}$/);
  const card = sent[0].card;
  assert.equal(card.header.template, 'green');
  assert.equal(card.header.title.content, '内部人才库短名单 · 已就绪');
  const buttons = allButtons(card);
  const keep = buttons.find((b) => b.value?.text?.startsWith('[BRAINTEX_CANDIDATE_KEEP]'));
  const add = buttons.find((b) => b.value?.text?.startsWith('[BRAINTEX_TALENT_ADD]'));
  assert.ok(keep, '必须有初筛通过按钮');
  assert.match(keep.value.text, /把项目 job-a 的候选人 reloop-profile:31 初筛通过。/);
  assert.match(keep.value.text, /candidate_ref=reloop-profile:31、action=KEEP_FOR_REVIEW、confirm=true/);
  assert.equal(add.value.text, '[BRAINTEX_TALENT_ADD] 职位 job-a 候选人 reloop-profile:31');
  assert.match(JSON.stringify(card), /1\. 张\*/, '姓名列是脱敏名纯文本');
  assert.match(JSON.stringify(card), /匹配度 78/);
  // envelope：名单撤下，只留引导纪律
  assert.deepEqual(out.data.items, []);
  assert.equal(out.data.card_delivered, true);
  assert.equal(out.data.items_count, 1);
  assert.equal(JSON.stringify(out).includes('张*'), false, 'envelope 不得再带候选人姓名');
  assert.equal(JSON.stringify(out).includes('reloop-profile:31'), false, 'envelope 不得再带候选人引用');
  assert.ok(out.recommendations.some((r) => r.action === 'guide_only' && r.note.includes('不要')));
});

test('群上下文翻页：幂等键携带 page token', async () => {
  const sent = [];
  await talentHandlers(sent).brainx_candidate_shortlist({ job_id: 'job-a', page_token: 'tok_page2' },
    groupPrincipal);
  assert.match(sent[0].idempotencyKey, /^shortlist-card:job-a:oc_group1:tok_page2:\d{4}-\d{2}-\d{2}$/);
});

test('私聊上下文不发卡，envelope 维持原样', async () => {
  const sent = [];
  const out = await talentHandlers(sent).brainx_candidate_shortlist({ job_id: 'job-a' }, p2pPrincipal);
  assert.equal(sent.length, 0);
  assert.equal(out.data.items.length, 1);
  assert.equal(out.data.card_delivered, undefined);
});

test('发卡失败（同步抛错/异步拒绝）不阻断，envelope 维持原样', async () => {
  const syncThrow = await talentHandlers([], () => { throw new Error('FEISHU_DOWN'); })
    .brainx_candidate_shortlist({ job_id: 'job-a' }, groupPrincipal);
  assert.equal(syncThrow.data.items.length, 1, '同步失败时模型仍能拿到名单交付');
  const asyncReject = await talentHandlers([], () => Promise.reject(new Error('FEISHU_DOWN')))
    .brainx_candidate_shortlist({ job_id: 'job-a' }, groupPrincipal);
  assert.equal(asyncReject.data.card_delivered, true, '异步失败按已受理处理（best-effort）');
});

// —— openmai_search done 群读回 ——

function jobsFixture(sendCardFn) {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  recommend(db, 'felix', { top: 5 });
  const projectId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1")
    .get().project_id;
  const action = createActionToolHandlers({ db, startSearchFn: () => ({ status: 'triggered', task_id: 'stub' }) });
  action.brainx_accept_job({ job_id: projectId, goal: '找到候选人', action_title: '启动找人',
    due_at: new Date(Date.now() + 2 * 86400000).toISOString(),
    idempotency_key: 'agent:om:card', confirm: true }, p2pPrincipal);
  return { db, projectId, handlers: createJobToolHandlers({ db, sendCardFn,
    publicBaseUrl: 'https://base.yorkteam.cn' }) };
}

function insertResult(db, projectId, status, at = new Date().toISOString()) {
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?,?,?,?,?,?,?)`).run(projectId, 'felix', status,
    status === 'done' ? '# 候选人\n1. 张三｜上海｜5年招聘经验' : null, `om_${status}`, at, at);
}

test('openmai_search done 群读回：发卡且 envelope 只留引导；running 不发卡', async () => {
  const sent = [];
  const { db, projectId, handlers } = jobsFixture((payload) => { sent.push(payload); return { message_id: 'om_y' }; });
  insertResult(db, projectId, 'done');
  const out = handlers.brainx_openmai_search({ job_id: projectId }, groupPrincipal);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 'oc_group1');
  assert.match(sent[0].idempotencyKey, /^openmai-result-card:.+:oc_group1:round1:\d{4}-\d{2}-\d{2}$/);
  assert.equal(sent[0].card.header.title.content, 'OpenMai 候选人推荐 · 首轮已就绪');
  assert.equal(out.data.card_delivered, true);
  assert.equal(out.data.result_text, null, '已发卡后 result_text 不再交给模型');
  assert.ok(out.recommendations.some((r) => r.action === 'guide_only'));
  assert.ok(out.unknowns.some((u) => u.includes('复用')), '复用纪律保留');

  db.prepare(`UPDATE openmai_results SET status='running', result_text=NULL WHERE project_id=?`).run(projectId);
  const running = handlers.brainx_openmai_search({ job_id: projectId }, groupPrincipal);
  assert.equal(sent.length, 1, 'running 不再发卡');
  assert.equal(running.data.status, 'running');
  db.close();
});

test('openmai_search done 私聊读回：不发卡，result_text 原样带出', async () => {
  const sent = [];
  const { db, projectId, handlers } = jobsFixture((payload) => sent.push(payload));
  insertResult(db, projectId, 'done');
  const out = handlers.brainx_openmai_search({ job_id: projectId }, p2pPrincipal);
  assert.equal(sent.length, 0);
  assert.ok(out.data.result_text.includes('张三'));
  assert.ok(out.recommendations.some((r) => r.action === 'present_result'));
  db.close();
});

test('buildShortlistCard：缺字段回退不炸（无经历/无学历/无城市）', () => {
  const card = buildShortlistCard({ job: { project_id: 'job-a', company: '', role: '' }, items: [
    { candidate_ref: 'talent-db:1', display_name_masked: '候*', rank: 1,
      profile: { current_city: null, recent_experiences: [], education: [], skills: [] },
      strength: { score: 60, summary: '标签命中' }, job_fit: { score: 61 } },
  ] });
  const text = JSON.stringify(card);
  assert.match(text, /当前职位/);
  assert.match(text, /待核实/);
  assert.match(text, /候选人/);
});
