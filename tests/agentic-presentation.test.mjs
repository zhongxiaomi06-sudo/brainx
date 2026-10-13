import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { updateProfile } from '../src/roster.js';
import { runAgenticRanking } from '../src/agentic-ranking.js';
import { agenticRecommendationPage } from '../src/agentic-ranking/presentation.js';
import { buildAgenticDailyCard } from '../src/push.js';
import { feedback, undoFeedback } from '../src/recommendation-batch.js';

const request = {
  tenantId: 'brainx', consultantId: 'felix', authorizationVersion: 'auth-v1',
};

function seededDb() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  updateProfile(db, 'felix', { profile_keywords: ['AI'], profile_note: '展示测试' });
  return db;
}

function output(input, candidates = input.candidates.slice(0, 3)) {
  return {
    schema_version: 'agentic-ranking-v1', run_id: input.run_id, decision: 'RECOMMEND',
    items: candidates.map((candidate, index) => ({
      job_id: candidate.job_id, job_fact_version: candidate.job_fact_version, rank: index + 1,
      decision_tier: index ? 'MONITOR' : 'TODAY', reason_codes: ['EXPLICIT_DIRECTION'],
      reason: `Agent 原因 ${index + 1}`, tradeoff: `权衡 ${index + 1}`,
      evidence_refs: [candidate.evidence_refs[0]], uncertainties: [`待核实 ${index + 1}`],
      suggested_next_action: `下一步 ${index + 1}`,
    })),
    not_selected: [], missing_information: [], stop_reason: 'SUFFICIENT_EVIDENCE',
  };
}

async function publish(db, { runMode = 'LIVE', pick } = {}) {
  return runAgenticRanking(db, request, {
    enabled: true, runMode, modelId: 'presentation-model', providerId: 'test-provider',
    agentFn: async ({ input }) => ({ output: output(input,
      pick ? pick(input.candidates) : input.candidates.slice(0, 3)) }),
  });
}

test('A 展示只读 LIVE，保持数据库 rank 且不返回旧分数', async () => {
  const db = seededDb();
  await publish(db, { runMode: 'SHADOW' });
  let selected;
  const live = await publish(db, { pick: (candidates) => {
    selected = [candidates[2], candidates[0], candidates[1]];
    return selected;
  } });
  const page = agenticRecommendationPage(db, 'felix');
  assert.equal(page.engine, 'agentic-ranking-v1');
  assert.equal(page.run_id, live.run_id);
  assert.deepEqual(page.items.map((item) => item.job.project_id), selected.map((item) => item.job_id));
  assert.deepEqual(page.items.map((item) => item.rank), [1, 2, 3]);
  assert.equal(page.total_count, 3);
  assert.ok(page.evaluated_count >= 3);
  assert.equal(page.state, 'READY');
  for (const item of page.items) {
    assert.equal('score' in item, false);
    assert.equal('confidence_band' in item, false);
    assert.match(item.reason, /^Agent 原因/);
    assert.ok(item.evidence_refs.length);
    assert.ok(item.uncertainties.length);
  }
});

test('A 游标冻结 run 和原 rank，搜索不重排，旧分排序明确拒绝', async () => {
  const db = seededDb();
  await publish(db, { pick: (candidates) => candidates.slice(0, 20) });
  const first = agenticRecommendationPage(db, 'felix', { pageSize: 2 });
  assert.ok(first.next_cursor);
  const frozenRun = first.run_id;
  const searchedCompany = first.items[1].job.company;
  const search = agenticRecommendationPage(db, 'felix', { search: searchedCompany });
  assert.ok(search.items.length >= 1);
  assert.ok(search.items.every((item, index, items) => index === 0 || item.rank > items[index - 1].rank));
  await publish(db, { pick: (candidates) => candidates.slice(3, 6) });
  const second = agenticRecommendationPage(db, 'felix', { cursor: first.next_cursor, pageSize: 2 });
  assert.equal(second.run_id, frozenRun);
  assert.equal(second.items[0].rank, 3);
  const rejected = agenticRecommendationPage(db, 'felix', { sort: 'activity' });
  assert.equal(rejected.code, 'AGENTIC_ORDER_IMMUTABLE');
});

test('撤权或关闭职位只撤下项目并保留原始 rank 缺口', async () => {
  const db = seededDb();
  const live = await publish(db);
  const rows = db.prepare(`SELECT job_id, rank FROM agentic_ranking_items
    WHERE run_id=? ORDER BY rank`).all(live.run_id);
  db.prepare(`DELETE FROM job_memberships
    WHERE consultant_id='felix' AND project_id=?`).run(rows[0].job_id);
  db.prepare(`UPDATE job_facts SET active_state='CLOSED' WHERE project_id=?`).run(rows[1].job_id);
  const page = agenticRecommendationPage(db, 'felix');
  assert.deepEqual(page.items.map((item) => item.rank), [3]);
  assert.equal(page.total_count, 1);
  assert.equal(page.original_total_count, 3);
});

test('生成、失败恢复、弃权和旧结果状态不互相伪装', async () => {
  const db = seededDb();
  const live = await publish(db);
  const input = db.prepare('SELECT input_json FROM agentic_ranking_runs WHERE run_id=?')
    .get(live.run_id).input_json;
  db.prepare(`INSERT INTO agentic_ranking_runs
    (run_id,tenant_id,consultant_id,generation,status,run_mode,algorithm_version,
     source_snapshot_id,profile_version,signal_snapshot_id,load_version,authorization_version,
     candidate_set_ref,model_id,prompt_version,tool_schema_version,eligibility_policy_version,
     diversity_policy_version,budget_json,input_json,eligible_count,retrieved_count,created_at)
    SELECT 'arr-newer','brainx','felix',generation+1,'FAILED','LIVE',algorithm_version,
     source_snapshot_id,profile_version,signal_snapshot_id,load_version,authorization_version,
     candidate_set_ref,model_id,prompt_version,tool_schema_version,eligibility_policy_version,
     diversity_policy_version,budget_json,?,eligible_count,retrieved_count,'2099-01-01T00:00:00.000Z'
    FROM agentic_ranking_runs WHERE run_id=?`).run(input, live.run_id);
  const previous = agenticRecommendationPage(db, 'felix');
  assert.equal(previous.run_id, live.run_id);
  assert.equal(previous.state, 'PREVIOUS_RESULT');
  assert.equal(previous.latest_status, 'FAILED');

  const fresh = seededDb();
  fresh.prepare(`INSERT INTO agentic_ranking_runs
    (run_id,tenant_id,consultant_id,generation,status,run_mode,algorithm_version,
     source_snapshot_id,profile_version,signal_snapshot_id,load_version,authorization_version,
     candidate_set_ref,model_id,prompt_version,tool_schema_version,eligibility_policy_version,
     diversity_policy_version,budget_json,input_json,eligible_count,retrieved_count,created_at)
    VALUES ('arr-running','brainx','felix',1,'RUNNING','LIVE','agentic-ranking-v1',
     's','p','sig','l','a','c','m','pv','t','e','d','{}','{}',0,0,'2099-01-01T00:00:00.000Z')`).run();
  assert.equal(agenticRecommendationPage(fresh, 'felix').state, 'GENERATING');

  const abstained = seededDb();
  const result = await runAgenticRanking(abstained, request, {
    enabled: true, agentFn: async ({ input }) => ({ output: {
      schema_version: 'agentic-ranking-v1', run_id: input.run_id, decision: 'ABSTAIN',
      items: [], not_selected: [], missing_information: ['证据不足'],
      stop_reason: 'INSUFFICIENT_EVIDENCE',
    } }),
  });
  assert.equal(result.status, 'ABSTAINED');
  assert.equal(agenticRecommendationPage(abstained, 'felix').state, 'ABSTAINED');
});

test('A 主动设置保存偏好、排除项和容量，非法值失败且不擦除旧字段', () => {
  const db = seededDb();
  const saved = updateProfile(db, 'felix', {
    profile_keywords: ['AI 基础设施'], excluded_companies: ['测试客户'],
    excluded_roles: ['销售'], excluded_cities: ['海外'], capacity_limit: 7,
  });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.excluded_companies, ['测试客户']);
  assert.equal(saved.capacity_limit, 7);
  const version = JSON.parse(db.prepare(`SELECT profile_json FROM consultant_profile_versions
    WHERE consultant_id='felix' ORDER BY version DESC LIMIT 1`).get().profile_json);
  assert.deepEqual(version.excluded_roles, ['销售']);
  assert.equal(updateProfile(db, 'felix', { excluded_cities: '上海' }).status, 422);
  assert.equal(updateProfile(db, 'felix', { capacity_limit: 0 }).status, 422);
});

test('A 忽略与撤销动作复用决策引用并保持幂等', async () => {
  const db = seededDb();
  await publish(db);
  const page = agenticRecommendationPage(db, 'felix');
  const first = page.items[0];
  const input = { project_id: first.job.project_id, decision_id: first.decision_id,
    feedback: 'NOT_INTERESTED', reason: '方向不匹配', idempotency_key: 'agentic-ignore-1' };
  const recorded = feedback(db, 'felix', input, { agenticReadEnabled: true });
  const duplicate = feedback(db, 'felix', input, { agenticReadEnabled: true });
  assert.equal(recorded.ok, true);
  assert.equal(duplicate.already, true);
  assert.equal(agenticRecommendationPage(db, 'felix').items.some(
    (item) => item.job.project_id === first.job.project_id), false);
  const undone = undoFeedback(db, 'felix', { project_id: first.job.project_id,
    decision_id: first.decision_id, idempotency_key: 'agentic-ignore-undo-1' },
  { agenticReadEnabled: true });
  const undoneAgain = undoFeedback(db, 'felix', { project_id: first.job.project_id,
    decision_id: first.decision_id, idempotency_key: 'agentic-ignore-undo-1' },
  { agenticReadEnabled: true });
  assert.equal(undone.removed, true);
  assert.equal(undoneAgain.already, true);
});

test('飞书 A 卡片保持原 rank 和原文案，不补 score、概率或六维', async () => {
  const db = seededDb();
  await publish(db);
  const page = agenticRecommendationPage(db, 'felix');
  const card = buildAgenticDailyCard({ consultant_name: 'Felix', run: page,
    items: page.items, commitments: { accepted_count: 0, need_action_count: 0 },
    publicBaseUrl: 'https://brainx.example.com' });
  const text = JSON.stringify(card);
  const positions = page.items.map((item) => text.indexOf(`**${item.rank}. ${item.job.role}**`));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.doesNotMatch(text, /综合|Fit |Activity|Evidence|概率|置信/);
  assert.match(text, /Agent 原因 1/);
  assert.match(text, /依据引用/);
  assert.match(text, new RegExp(page.items[0].evidence_refs[0]));
  assert.match(text, /待核实 1/);
});
