/** baseline-1.1 测试（2026-08-24）：方案 A 节流 + 反馈闭环（公司级记忆/僵尸降权）。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend, latestRun, buildCtx } from '../src/recommend.js';
import { engage, currentState } from '../src/engagement.js';
import { scoreJob, POLICY_VERSION } from '../src/scorer.js';
import { recordOpportunityIgnore } from '../src/opportunity-ignore.js';

let db;
const CID = 'felix';
before(() => { db = openDb(':memory:'); });

const baseCtx = { consultant_id: 'mia', profile_keywords: ['算法'], historical_texts: [],
  watched_count: 0, accepted_count: 0, outcomes_avg: null, now: '2026-08-24T00:00:00.000Z' };
const mkJob = (over = {}) => ({ project_id: 'PJ11', company: '甲公司', role: '算法工程师',
  pipeline: null, active_state: 'OPEN', captured_at: '2026-08-24', priority: null,
  chat_last_at: '2026-08-23 22:00', ...over });
const dimOf = (scored, d) => scored.breakdown.find((x) => x.dim === d).score;

// —— 方案 A：节流 ——
test('A：自动轮 <2h → 节流跳过冻结，记 SKIPPED_THROTTLED，latestRun 不受影响', () => {
  runSync(db, { source: 'fixture', consultant_id: CID });
  const r1 = recommend(db, CID, { top: 20, throttle: true });
  assert.ok(!r1.skipped && r1.run_id, '首轮正常冻结');
  const recsBefore = db.prepare('SELECT COUNT(*) n FROM recommendations').get().n;
  // 模拟 bridge 下一轮：sync_id 必然变化，但业务输入及 input_hash 不变。
  // 这是旧实现失效并造成数据库膨胀的真实路径。
  const beforeSnapshot = db.prepare(`SELECT snapshot_id FROM decision_runs WHERE run_id=?`).get(r1.run_id).snapshot_id;
  const repeated = runSync(db, { source: 'fixture', consultant_id: CID });
  assert.notEqual(repeated.sync_id, beforeSnapshot);
  const r2 = recommend(db, CID, { top: 20, throttle: true });
  assert.equal(r2.skipped, true);
  assert.equal(r2.run_id, r1.run_id, '复用上轮 run_id');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM recommendations').get().n, recsBefore, '零新增冻结行');
  const skipped = db.prepare(`SELECT status FROM decision_runs
    WHERE consultant_id=? AND status='SKIPPED_THROTTLED'`).get(CID);
  assert.ok(skipped, '审计行已记');
  recommend(db, CID, { top: 20, throttle: true });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM decision_runs
    WHERE consultant_id=? AND status='SKIPPED_THROTTLED'`).get(CID).n, 1,
  '一小时内重复跳过只保留一条审计记录');
  const latest = latestRun(db, CID);
  assert.equal(latest.run.run_id, r1.run_id, 'latestRun 仍指向 COMPLETED 轮');
  assert.ok(latest.items.length > 0);
});

test('A：快照变化也不能绕过自动硬间隔；手动 run 仍可立即重算', () => {
  const r = recommend(db, CID, { top: 20 }); // 手动路径
  assert.ok(!r.skipped && r.run_id);
  // TTC 分页会让快照不断变化；自动轮仍必须复用两小时内的正式轮次。
  runSync(db, { source: 'ttc', consultant_id: CID, payload: { as_of: new Date().toISOString(), jobs: [
    { project_id: 'JTHROT', company: '新客户', role: '新职位', city: null, pipeline: null, hc: null,
      active_state: 'OPEN', source_url: 'ttc://job/JTHROT' },
  ] } });
  const r2 = recommend(db, CID, { top: 20, throttle: true });
  assert.equal(r2.skipped, true, '快照变化也不能绕过自动硬间隔');
  const manual = recommend(db, CID, { top: 20 });
  assert.ok(!manual.skipped && manual.run_id !== r.run_id, '人工重算仍立即生成新轮次');
});

test('推荐快照不再污染人工决策轨迹，推荐态从 recommendations 推导', () => {
  const local = openDb(':memory:');
  try {
    runSync(local, { source: 'fixture', consultant_id: CID });
    const out = recommend(local, CID, { top: 20 });
    assert.ok(out.items.length > 0);
    assert.equal(local.prepare(`SELECT COUNT(*) n FROM decision_events
      WHERE event_type='RECOMMENDED'`).get().n, 0, '推荐轮次不写机器轨迹');
    assert.equal(currentState(local, CID, out.items[0].job.project_id).state, 'RECOMMENDED',
      '状态仍能由冻结推荐推导');
  } finally {
    local.close();
  }
});

test('A：推荐快照只保留最近三轮，并限制每轮冻结规模', () => {
  const local = openDb(':memory:');
  try {
    runSync(local, { source: 'fixture', consultant_id: CID });
    for (let round = 0; round < 4; round += 1) {
      recommend(local, CID, { top: 5, persistLimit: 5 });
    }
    assert.equal(
      local.prepare('SELECT COUNT(*) n FROM recommendations WHERE consultant_id=?').get(CID).n,
      15,
      '仅保留最近三轮、每轮五条冻结记录',
    );
    assert.equal(latestRun(local, CID).items.length, 5);
  } finally {
    local.close();
  }
});

// —— 反馈闭环：公司级记忆 ——
test('1.1：负向公司记忆 direction -15，正向承接公司 +10', () => {
  const job = mkJob();
  const plain = dimOf(scoreJob(job, 'TEAM_SHARED', baseCtx), 'direction');
  const neg = dimOf(scoreJob(job, 'TEAM_SHARED', { ...baseCtx, negative_companies: ['甲公司'] }), 'direction');
  const pos = dimOf(scoreJob(job, 'TEAM_SHARED', { ...baseCtx, positive_companies: ['甲公司'] }), 'direction');
  assert.equal(neg, Math.max(0, plain - 15));
  assert.equal(pos, Math.min(100, plain + 10));
});

test('1.1：僵尸职位 ≥3 轮零互动 → 活跃 7 折；有互动则不衰减', () => {
  const job = mkJob();
  const plain = dimOf(scoreJob(job, 'TEAM_SHARED', baseCtx), 'activity');
  const zombie = dimOf(scoreJob(job, 'TEAM_SHARED',
    { ...baseCtx, rec_rounds: { PJ11: 3 }, engaged_projects: new Set() }), 'activity');
  assert.equal(zombie, Math.round(plain * 0.7));
  const engaged = dimOf(scoreJob(job, 'TEAM_SHARED',
    { ...baseCtx, rec_rounds: { PJ11: 5 }, engaged_projects: new Set(['PJ11']) }), 'activity');
  assert.equal(engaged, plain, '有互动不触发僵尸衰减');
  const two = dimOf(scoreJob(job, 'TEAM_SHARED',
    { ...baseCtx, rec_rounds: { PJ11: 2 }, engaged_projects: new Set() }), 'activity');
  assert.equal(two, plain, '2 轮未互动不触发（阈值 3）');
});

// —— 反馈闭环：buildCtx 全链路 ——
test('1.1：IGNORE/ACCEPT 回流 buildCtx 的公司记忆与轮次信号', () => {
  runSync(db, { source: 'ttc', consultant_id: 'mia', payload: { as_of: new Date().toISOString(), jobs: [
    { project_id: 'JNEG', company: '负向客户', role: '职位A', city: null, pipeline: null, hc: null,
      active_state: 'OPEN', source_url: 'ttc://job/JNEG' },
    { project_id: 'JPOS', company: '正向客户', role: '职位B', city: null, pipeline: null, hc: null,
      active_state: 'OPEN', source_url: 'ttc://job/JPOS' },
  ] } });
  recommend(db, 'mia', { top: 20 });
  recordOpportunityIgnore(db, 'mia', 'JNEG', 't-ignore-1');
  engage(db, 'mia', 'JPOS', 'ACCEPT', { confirm: true, idempotency_key: 't-accept-1' });
  const ctx = buildCtx(db, 'mia', { sync_id: 'x' });
  assert.ok(ctx.negative_companies.includes('负向客户'), 'IGNORE 公司进负向记忆');
  assert.ok(ctx.positive_companies.includes('正向客户'), 'ACCEPT 公司进正向记忆');
  assert.ok(ctx.feedback_projects.includes('JNEG') && ctx.engaged_projects.has('JPOS'));
  // 推荐轮次从冻结快照聚合，不再依赖机器 decision_events。
  assert.ok(Object.keys(ctx.rec_rounds).length > 0
    && Math.max(...Object.values(ctx.rec_rounds)) >= 1, '推荐轮次表已聚合');
});

test('1.1：POLICY_VERSION 晋升', () => {
  assert.equal(POLICY_VERSION, 'baseline-1.1');
});

after(() => { db.close(); });
