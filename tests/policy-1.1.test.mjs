/** baseline-1.1 测试（2026-08-24）：方案 A 节流 + 反馈闭环（公司级记忆/僵尸降权）。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend, latestRun, buildCtx } from '../src/recommend.js';
import { engage } from '../src/engagement.js';
import { scoreJob, POLICY_VERSION } from '../src/scorer.js';

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
test('A：快照未变且 <2h → 节流跳过冻结，记 SKIPPED_UNCHANGED，latestRun 不受影响', () => {
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
    WHERE consultant_id=? AND status='SKIPPED_UNCHANGED'`).get(CID);
  assert.ok(skipped, '审计行已记');
  recommend(db, CID, { top: 20, throttle: true });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM decision_runs
    WHERE consultant_id=? AND status='SKIPPED_UNCHANGED'`).get(CID).n, 1,
  '一小时内重复跳过只保留一条审计记录');
  const latest = latestRun(db, CID);
  assert.equal(latest.run.run_id, r1.run_id, 'latestRun 仍指向 COMPLETED 轮');
  assert.ok(latest.items.length > 0);
});

test('A：手动 run（无 throttle）不受限；快照变化后自动轮重新冻结', () => {
  const r = recommend(db, CID, { top: 20 }); // 手动路径
  assert.ok(!r.skipped && r.run_id);
  // 快照变化（新同步带新数据）→ 自动轮重新冻结
  runSync(db, { source: 'ttc', consultant_id: CID, payload: { as_of: new Date().toISOString(), jobs: [
    { project_id: 'JTHROT', company: '新客户', role: '新职位', city: null, pipeline: null, hc: null,
      active_state: 'OPEN', source_url: 'ttc://job/JTHROT' },
  ] } });
  const r2 = recommend(db, CID, { top: 20, throttle: true });
  assert.ok(!r2.skipped, '快照已变 → 不节流');
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
test('1.1：DISMISS/ACCEPT 回流 buildCtx 的公司记忆与轮次信号', () => {
  runSync(db, { source: 'ttc', consultant_id: 'mia', payload: { as_of: new Date().toISOString(), jobs: [
    { project_id: 'JNEG', company: '负向客户', role: '职位A', city: null, pipeline: null, hc: null,
      active_state: 'OPEN', source_url: 'ttc://job/JNEG' },
    { project_id: 'JPOS', company: '正向客户', role: '职位B', city: null, pipeline: null, hc: null,
      active_state: 'OPEN', source_url: 'ttc://job/JPOS' },
  ] } });
  recommend(db, 'mia', { top: 20 });
  engage(db, 'mia', 'JNEG', 'DISMISS', { reason: '不符合方向', idempotency_key: 't-dismiss-1' });
  engage(db, 'mia', 'JPOS', 'WATCH', { idempotency_key: 't-watch-1' });
  engage(db, 'mia', 'JPOS', 'ACCEPT', { confirm: true, idempotency_key: 't-accept-1' });
  const ctx = buildCtx(db, 'mia', { sync_id: 'x' });
  assert.ok(ctx.negative_companies.includes('负向客户'), 'DISMISS 公司进负向记忆');
  assert.ok(ctx.positive_companies.includes('正向客户'), 'ACCEPT 公司进正向记忆');
  assert.ok(ctx.engaged_projects.has('JNEG') && ctx.engaged_projects.has('JPOS'));
  // RECOMMENDED 事件只落在 rank≤20 的行：JNEG/JPOS 未必进榜，
  // 这里验证的是 buildCtx 正确聚合了轮次表（榜上职位有计数）
  assert.ok(Object.keys(ctx.rec_rounds).length > 0
    && Math.max(...Object.values(ctx.rec_rounds)) >= 1, '推荐轮次表已聚合');
});

test('1.1：POLICY_VERSION 晋升', () => {
  assert.equal(POLICY_VERSION, 'baseline-1.1');
});

after(() => { db.close(); });
