/** spec-backend-1 验收测试（2026-08-30 算法文档第一批后端）。
 * 覆盖：0021 迁移（impressions/索引/feedback UNIQUE）、曝光埋点与探索位口径、
 * served 回填、0-5 标签映射、评估脚本形状。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { recommendationPage } from '../src/recommendation-page.js';
import { engage } from '../src/engagement.js';
import { recordOutcome } from '../src/replay.js';
import { labelFor, labelsForRun } from '../src/labels.js';
import { evaluate } from '../scripts/eval-ranking.mjs';

let db;
before(() => { db = openDb(':memory:'); });
after(() => { db.close(); });

test('0021：impressions 表/热索引/feedback 唯一索引全部落库', () => {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='recommendation_impressions'`).all();
  assert.equal(tables.length, 1);
  const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index'
    AND name IN ('idx_recs_consultant_project','idx_feedback_unique')`).all().map((r) => r.name);
  assert.deepEqual(idx.sort(), ['idx_feedback_unique', 'idx_recs_consultant_project']);
});

test('曝光埋点：冻结时按 rank 落库，探索位约 top×ε，propensity 正确', () => {
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  recommend(db, 'felix', { top: 20 });
  const rows = db.prepare('SELECT slot_kind, COUNT(*) n FROM recommendation_impressions GROUP BY 1').all();
  const total = rows.reduce((s, r) => s + r.n, 0);
  const explore = rows.find((r) => r.slot_kind === 'EXPLORATION')?.n || 0;
  assert.equal(total, 20);
  assert.ok(explore >= 1 && explore <= 3, `探索位 ${explore} 应在 1-3（top×ε 口径）`);
  const p = db.prepare(`SELECT propensity FROM recommendation_impressions WHERE slot_kind='EXPLORATION' LIMIT 1`).get();
  assert.equal(p.propensity, 0.1);
  const n = db.prepare(`SELECT propensity FROM recommendation_impressions WHERE slot_kind='NORMAL' LIMIT 1`).get();
  assert.equal(n.propensity, 1.0);
});

test('served 回填：page 真实下发后 served_at 补齐且幂等', () => {
  const before = db.prepare('SELECT COUNT(*) n FROM recommendation_impressions WHERE served_at IS NOT NULL').get().n;
  recommendationPage(db, 'felix', {});
  const mid = db.prepare('SELECT COUNT(*) n FROM recommendation_impressions WHERE served_at IS NOT NULL').get().n;
  assert.ok(mid > before);
  recommendationPage(db, 'felix', {}); // 再读一次不重复推进（幂等）
  const after = db.prepare('SELECT COUNT(*) n FROM recommendation_impressions WHERE served_at IS NOT NULL').get().n;
  assert.equal(mid, after);
});

test('0-5 标签：终局优先于承接态，未互动为未知，历史 DISMISSED/×为 0', () => {
  const pid = db.prepare(`SELECT project_id FROM recommendations
    WHERE consultant_id='felix' ORDER BY rank LIMIT 1`).get().project_id;
  assert.equal(labelFor(db, 'felix', pid), null, '未展示未互动=未知');
  // 新模型动作表无 WATCH/DISMISS；历史账本态直插事件模拟（与 0021 迁移前数据同形，
  // labels 读 current_engagement 视图原始态，不经过 publicEngagementState 折叠）
  const put = (id, type, next, projectId = pid) => db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, decision_id, policy_version, idempotency_key, prev_state, next_state, payload_json)
    VALUES (?,?,?,datetime('now'),?,NULL,'test',?,'VIEWED',?,'{}')`)
    .run(id, type, 'felix', projectId, `lbl:${id}`, next);
  put('e-watch', 'WATCHED', 'WATCHED');
  assert.equal(labelFor(db, 'felix', pid), 1);
  engage(db, 'felix', pid, 'ACCEPT', { confirm: true, idempotency_key: 'lbl-2' });
  assert.equal(labelFor(db, 'felix', pid), 2);
  recordOutcome(db, 'felix', { project_id: pid, stage: '面试', value: { rating: 4 }, idempotency_key: 'lbl-3' });
  assert.equal(labelFor(db, 'felix', pid), 4);
  recordOutcome(db, 'felix', { project_id: pid, stage: '入职', value: {}, idempotency_key: 'lbl-4' });
  assert.equal(labelFor(db, 'felix', pid), 5);
  const pid2 = db.prepare(`SELECT project_id FROM recommendations
    WHERE consultant_id='felix' AND project_id != ? ORDER BY rank LIMIT 1`).get(pid).project_id;
  put('e-dismiss', 'DISMISSED', 'DISMISSED', pid2);
  assert.equal(labelFor(db, 'felix', pid2), 0);
});

test('评估：排序组形状与指标范围', () => {
  const runId = db.prepare(`SELECT run_id FROM decision_runs
    WHERE consultant_id='felix' AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`).get().run_id;
  const rows = labelsForRun(db, 'felix', runId);
  assert.ok(rows.length > 0 && rows.every((r) => r.rank >= 1));
  const ev = evaluate(db, { runs: 1, consultant_ids: ['felix'] });
  assert.equal(ev.groups, 1);
  for (const v of Object.values(ev.metrics)) {
    if (v === null) continue;
    assert.ok(v >= 0 && v <= 1);
  }
});

test('SYNC_ALERT：日窗口键——同日去重、次日可再发', async () => {
  const { pushCard, buildSyncAlertCard, syncAlertKey } = await import('../src/push.js');
  const card = buildSyncAlertCard({ complete: 0, source: 'ttc', errors: ['限流'], as_of: now(), started_at: now() });
  const key1 = syncAlertKey('2026-08-30T02:00:00Z'); // CST 08-30
  const r1 = await pushCard(db, { consultant_id: 'felix', kind: 'SYNC_ALERT', run_id: key1, card, target: 'oc_x', send: false });
  assert.equal(r1.status, 'PREVIEW');
  // 同日同键：重发被 SKIPPED_DUPLICATE（send=false → PREVIEW 行，再发预览也幂等）
  const r2 = await pushCard(db, { consultant_id: 'felix', kind: 'SYNC_ALERT', run_id: key1, card, target: 'oc_x', send: false });
  assert.equal(r2.status, 'SKIPPED_DUPLICATE');
  // 次日新键：可以再发
  const key2 = syncAlertKey('2026-08-30T17:00:00Z'); // CST 08-31
  const r3 = await pushCard(db, { consultant_id: 'felix', kind: 'SYNC_ALERT', run_id: key2, card, target: 'oc_x', send: false });
  assert.equal(r3.status, 'PREVIEW');
});

test('数据隔离：source_mode 唯一权威=cockpit_facts 行存在；报告含弱归属', async () => {
  const { sourceModeOf, isolationReport } = await import('../src/data-isolation.js');
  const pid = db.prepare(`SELECT project_id FROM recommendations
    WHERE consultant_id='felix' ORDER BY rank LIMIT 1`).get().project_id;
  assert.equal(sourceModeOf(db, pid).source_mode, 'MARKET_ONLY');
  db.prepare(`INSERT INTO cockpit_facts (project_id, membership_status, cockpit_as_of, raw_json, updated_at)
    VALUES (?, 'UNCONFIRMED', ?, '{}', ?)`).run(pid, now(), now());
  assert.equal(sourceModeOf(db, pid).source_mode, 'COCKPIT_CONTEXT');
  const rep = isolationReport(db);
  assert.ok(rep.totals.cockpit_context >= 1 && rep.weak_ownership.count >= 1);
  assert.equal(rep.same_company_shadow.count, 0);
});

test('影子日报：分歧 TopN 形状与位移计算', async () => {
  const { divergenceTopN } = await import('../bin/brainx-shadow-daily.mjs');
  const { loadShadowModel } = await import('../src/shadow-rank.js');
  // 无模型文件时 loadShadowModel 返回 null——用内联微型模型替身验证位移逻辑
  const { writeFileSync } = await import('node:fs');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dump = { format: 'lightgbm-lambdarank-json', feature_order: ['hc'],
    model: { tree_info: [{ tree_structure: { split_feature: 0, threshold: 0.5,
      left_child: { leaf_value: 1 }, right_child: { leaf_value: 2 } } }], learning_rate: 1 } };
  const dir = mkdtempSync(join(tmpdir(), 'ltr-'));
  const mp = join(dir, 'm.json');
  writeFileSync(mp, JSON.stringify(dump));
  const model = loadShadowModel(mp);
  assert.ok(model && typeof model.score === 'function');
  const out = divergenceTopN(db, model, 'felix', { top: 3 });
  assert.ok(out && Array.isArray(out.top) && out.top.length <= 3);
  for (const t of out.top) {
    assert.ok(t.rule_rank >= 1 && t.shadow_rank >= 1 && t.delta >= 0);
  }
});
test('feedback 唯一索引：同三元组重复插入被拒', () => {
  assert.throws(() => {
    db.prepare(`INSERT INTO recommendation_feedback
      (feedback_id, consultant_id, project_id, snapshot_id, batch_id, feedback, reason, idempotency_key, created_at)
      VALUES ('fb_dup1','felix','P-X','s1','b1','NOT_INTERESTED','r','k1',?)`).run(now());
    db.prepare(`INSERT INTO recommendation_feedback
      (feedback_id, consultant_id, project_id, snapshot_id, batch_id, feedback, reason, idempotency_key, created_at)
      VALUES ('fb_dup2','felix','P-X','s1','b1','NOT_INTERESTED','r','k2',?)`).run(now());
  }, /UNIQUE/);
});
