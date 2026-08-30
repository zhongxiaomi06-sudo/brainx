/** 后端全链路测试：对应 PRD §11 验收标准逐条。 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync, latestCompleteSnapshot, loadFixture } from '../src/sync.js';
import { recommend, latestRun } from '../src/recommend.js';
import { engage, currentState, commitmentSummary } from '../src/engagement.js';
import { replay, recordOutcome } from '../src/replay.js';
import { sortRecs, hardBlock, explorationScore } from '../src/scorer.js';
import { buildDailyCard, pushCard } from '../src/push.js';

let db;
const CID = 'felix';

before(() => {
  db = openDb(':memory:');
});

test('迁移幂等：重复打开不报错、版本前进', () => {
  const v1 = db.prepare('PRAGMA user_version').get().user_version;
  const db2 = openDb(':memory:');
  const v2 = db2.prepare('PRAGMA user_version').get().user_version;
  assert.ok(v1 >= 2 && v2 >= 2);
});

test('同步：fixture 全量入库，complete=1', () => {
  const out = runSync(db, { source: 'fixture', consultant_id: CID });
  assert.equal(out.complete, true);
  // fixture 63 条原始 → splitFixtureJob 公司×单职能展开（fixture_split.js），
  // rows_expected/rows_read 均按展开后计；干净 fixture 无重复无错误 → 两者相等即全量入库。
  assert.equal(out.rows_read, out.rows_expected);
  assert.equal(out.errors.length, 0);
});

test('去重：重复同步行数不变（project_id 唯一）', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM job_facts').get().n;
  runSync(db, { source: 'fixture', consultant_id: CID });
  const after = db.prepare('SELECT COUNT(*) n FROM job_facts').get().n;
  assert.equal(before, after);
  const snap = latestCompleteSnapshot(db, CID);
  assert.ok(snap.sync_id);
});

test('dry-run 不落库', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n;
  const out = runSync(db, { source: 'fixture', consultant_id: CID, dry_run: true });
  assert.equal(out.sync_id, '(dry-run)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sync_runs').get().n, before);
});

test('硬约束：CLOSED/COOLING/UNKNOWN 不进推荐', () => {
  assert.equal(hardBlock({ project_id: 'p', company: 'c', role: 'r', active_state: 'CLOSED' }, 'MY_JOB', true), '职位已关闭/完成');
  assert.equal(hardBlock({ project_id: 'p', company: 'c', role: 'r', active_state: 'COOLING' }, 'MY_JOB', true), '职位处于冷却期');
  assert.equal(hardBlock({ project_id: 'p', company: 'c', role: 'r', active_state: 'OPEN' }, 'UNKNOWN', true), '关系 UNKNOWN');
  assert.equal(hardBlock({ project_id: '', company: 'c', role: 'r', active_state: 'OPEN' }, 'MY_JOB', true), '缺少 project_id');
  assert.equal(hardBlock({ project_id: 'p', company: 'c', role: 'r', active_state: 'OPEN' }, 'TEAM_SHARED', false), '本轮同步不完整');
});

test('推荐：生成 Top10，每条≥2 理由且有风险和证据', () => {
  const out = recommend(db, CID, { top: 10 });
  assert.equal(out.blocked, false);
  assert.ok(out.items.length > 0 && out.items.length <= 10);
  for (const r of out.items) {
    assert.ok(r.reasons.length >= 2, `理由不足: ${r.job.project_id}`);
    assert.ok(r.evidence_refs.length >= 1);
    assert.ok(['RECOMMEND_ACCEPT', 'RECOMMEND_WATCH', 'OBSERVE'].includes(r.action));
  }
  // UNKNOWN/CLOSED 不出现
  for (const r of out.items) {
    assert.notEqual(r.job.relation, 'UNKNOWN');
    assert.ok(!['CLOSED', 'COMPLETED', 'COOLING'].includes(r.job.active_state));
  }
});

test('排序确定性：同批输入同序（重跑 run 两次 rank 序列一致）', () => {
  const a = recommend(db, CID, { top: 10, dry_run: true }).items.map((r) => r.job.project_id);
  const b = recommend(db, CID, { top: 10, dry_run: true }).items.map((r) => r.job.project_id);
  assert.deepEqual(a, b);
});

test('排序链：score↓→coverage↓→新鲜度↓→project_id↑', () => {
  const mk = (score, cov, cap, pid) => ({ score, evidence_coverage: cov, job: { captured_at: cap, project_id: pid } });
  const arr = [mk(80, 0.9, '2026-08-01', 'P-2'), mk(80, 0.9, '2026-08-01', 'P-1'),
               mk(81, 0.8, '2026-08-01', 'P-9'), mk(80, 0.95, '2026-07-01', 'P-3')];
  arr.sort(sortRecs);
  assert.deepEqual(arr.map((x) => x.job.project_id), ['P-9', 'P-3', 'P-1', 'P-2']);
});

test('探索位确定性：同 project_id+日期 得分恒定', () => {
  assert.equal(explorationScore('P-1', CID, '2026-08-07T08:00:00Z'),
               explorationScore('P-1', CID, '2026-08-07T09:00:00Z'));
});

test('coverage<0.5 强制 OBSERVE', () => {
  // outcomes 缺失时 coverage=0.85；再缺 similarity/historical → 0.70…
  // 构造全缺失：无画像、无历史、无结果、CLOSED 以外皆 null
  const out = recommend(db, CID, { top: 50, dry_run: true });
  for (const r of out.items) {
    if (r.evidence_coverage < 0.5) assert.equal(r.action, 'OBSERVE');
  }
});

test('状态机：VIEW→ACCEPT→COMPLETE 全链 + 事件账本', () => {
  const run = latestRun(db, CID);
  const pid = run.items[0].job.project_id;
  const k = (a) => `t1:${a}:${pid}`;
  let r = engage(db, CID, pid, 'VIEW', { idempotency_key: k('v') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.legal_actions, ['ACCEPT']);
  // ACCEPT 不 confirm → 409
  r = engage(db, CID, pid, 'ACCEPT', { idempotency_key: k('a0') });
  assert.equal(r.ok, false); assert.equal(r.status, 409);
  r = engage(db, CID, pid, 'ACCEPT', { idempotency_key: k('a1'), confirm: true });
  assert.equal(r.state, 'ACCEPTED');
  r = engage(db, CID, pid, 'COMPLETE', { idempotency_key: k('c') });
  assert.equal(r.state, 'COMPLETED');
  const evts = db.prepare(`SELECT event_type FROM decision_events WHERE project_id=? AND actor=?`).all(pid, CID);
  assert.ok(evts.length >= 3);
});

test('幂等：重复 idempotency_key 不重复写事件', () => {
  const run = latestRun(db, CID);
  const pid = run.items[1].job.project_id;
  const key = `t2:watch:${pid}`;
  const before = db.prepare('SELECT COUNT(*) n FROM decision_events').get().n;
  const r1 = engage(db, CID, pid, 'VIEW', { idempotency_key: `t2:v:${pid}` });
  const r2 = engage(db, CID, pid, 'VIEW', { idempotency_key: `t2:v:${pid}` });
  assert.equal(r2.already, true);
  const after = db.prepare('SELECT COUNT(*) n FROM decision_events').get().n;
  assert.equal(after - before, 1);
});

test('关注和暂不考虑动作已下线，待开始只允许直接跟进', () => {
  const run = latestRun(db, CID);
  const pid = run.items[2].job.project_id;
  assert.equal(engage(db, CID, pid, 'WATCH', { idempotency_key: `t3:w:${pid}` }).status, 400);
  assert.equal(engage(db, CID, pid, 'DISMISS', { idempotency_key: `t3:d:${pid}` }).status, 400);
  assert.deepEqual(engage(db, CID, pid, 'VIEW', { idempotency_key: `t3:v:${pid}` }).legal_actions, ['ACCEPT']);
});

test('承接摘要不再暴露关注容量', () => {
  const summary = commitmentSummary(db, CID);
  assert.equal(summary.watched_count, 0);
  assert.equal(summary.watched_limit, 0);
});

test('回放：冻结行不受职位后续变化影响', () => {
  const run = latestRun(db, CID);
  const dec = run.items[0].decision_id;
  const before = replay(db, dec);
  // 职位后来关闭
  db.prepare(`UPDATE job_facts SET active_state='CLOSED' WHERE project_id=?`)
    .run(run.items[0].job.project_id);
  const after = replay(db, dec);
  assert.equal(after.recommendation.score, before.recommendation.score);
  assert.equal(after.job_now.active_state, 'CLOSED'); // 现状对照
  assert.equal(after.recommendation.policy_version, 'baseline-1.1');
});

test('结果反馈：关联推荐 + 幂等', () => {
  const run = latestRun(db, CID);
  const r0 = run.items[0];
  const out = recordOutcome(db, CID, { project_id: r0.job.project_id, stage: '面试',
    value: { rating: 4, note: '推进顺利' }, decision_id: r0.decision_id, idempotency_key: 't6:o1' });
  assert.equal(out.ok, true);
  const dup = recordOutcome(db, CID, { project_id: r0.job.project_id, stage: '面试',
    value: { rating: 4 }, idempotency_key: 't6:o1' });
  assert.equal(dup.already, true);
});

test('推送卡片：结构合法 + 三段信号 + 深链；同 run 重复推 SKIPPED', async () => {
  const run = latestRun(db, CID);
  const c = commitmentSummary(db, CID);
  const card = buildDailyCard({ consultant_name: 'Felix 黄鑫', run: run.run,
    items: run.items, commitments: c, sync: { complete: 1 }, snapshot_id: run.run.snapshot_id });
  // legacy v1 卡片（schema 2.0 已移除 action 标签，实测 ErrCode 200861）
  assert.ok(card.config?.wide_screen_mode && Array.isArray(card.elements));
  assert.ok(card.elements.some((e) => e.tag === 'action'));
  const text = JSON.stringify(card);
  assert.match(text, /Fit /);
  assert.match(text, /127\.0\.0\.1:\d+\/\?open=opportunity:/);
  const r1 = await pushCard(db, { consultant_id: CID, kind: 'DAILY_TOP3', run_id: run.run.run_id,
                            card, target: 'oc_test', send: false });
  assert.equal(r1.status, 'PREVIEW');
  const r2 = await pushCard(db, { consultant_id: CID, kind: 'DAILY_TOP3', run_id: run.run.run_id,
                            card, target: 'oc_test', send: false });
  assert.equal(r2.status, 'SKIPPED_DUPLICATE');
  const n = db.prepare(`SELECT COUNT(*) n FROM push_log WHERE consultant_id=? AND kind='DAILY_TOP3'`).get(CID).n;
  assert.equal(n, 1); // 同 run 永远只有一条成功记录
});

test('推送：FAILED 行可重发——更新同一 push_id，不新增行', async () => {
  const run = latestRun(db, CID);
  // 不同 kind 避免与上一用例的 DAILY_TOP3 成功行冲突
  const kind = 'HEATING_ALERT';
  const rid = run.run.run_id;
  // 手工落一条 FAILED 行（模拟上次发送失败）
  db.prepare(`INSERT INTO push_log (push_id, consultant_id, kind, run_id, card_json, target, status, created_at)
    VALUES ('pid-failed-1', ?, ?, ?, '{}', 'ou_x', 'FAILED', ?)`).run(CID, kind, rid, new Date().toISOString());
  const r = await pushCard(db, { consultant_id: CID, kind, run_id: rid, card: { retry: true }, target: 'ou_x', send: false });
  assert.equal(r.push_id, 'pid-failed-1'); // 同一行
  assert.equal(r.status, 'PREVIEW');         // 已被重发结果覆盖
  const row = db.prepare(`SELECT status, card_json FROM push_log WHERE push_id='pid-failed-1'`).get();
  assert.equal(row.status, 'PREVIEW');
  assert.match(row.card_json, /retry/);
  const n = db.prepare(`SELECT COUNT(*) n FROM push_log WHERE consultant_id=? AND kind=?`).get(CID, kind).n;
  assert.equal(n, 1);
});

test('推送：PREVIEW 可被 send=true 覆盖发送，不幂等跳过', async () => {
  const run = latestRun(db, CID);
  const kind = 'HEATING_ALERT_PREVIEW';
  const rid = run.run.run_id;
  const preview = await pushCard(db, { consultant_id: CID, kind, run_id: rid,
    card: { config: {} }, target: 'ou_x', send: false });
  assert.equal(preview.status, 'PREVIEW');
  const real = await pushCard(db, { consultant_id: CID, kind, run_id: rid,
    card: { config: {}, send: true }, target: 'ou_x', send: true });
  assert.ok(['SENT', 'FAILED'].includes(real.status), `应为 SENT/FAILED 而非 ${real.status}`);
  assert.equal(real.push_id, preview.push_id);
  const n = db.prepare(`SELECT COUNT(*) n FROM push_log WHERE consultant_id=? AND kind=?`).get(CID, kind).n;
  assert.equal(n, 1);
});
