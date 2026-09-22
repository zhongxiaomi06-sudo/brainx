import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { recommendationPage } from '../src/recommendation-page.js';
import { recordOutcome } from '../src/replay.js';
import { exportDataset } from '../bin/brainx-ltr-export.mjs';
import { evaluate } from '../scripts/eval-ranking.mjs';
import { divergenceTopN } from '../bin/brainx-shadow-daily.mjs';
import { readFeatureSnapshot, LTR_FEATURES } from '../src/ltr-features.js';

const labelWindow = () => ({ windowDays: 7,
  cutoffAt: new Date(Date.now() + 8 * 86400000).toISOString() });

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const run = recommend(db, 'felix', { top: 20 });
  assert.equal(run.blocked, false);
  recommendationPage(db, 'felix', {});
  return { db, run };
}

function labelFirst(db, run, suffix) {
  const first = run.items[0];
  const outcome = recordOutcome(db, 'felix', {
    project_id: first.job.project_id,
    stage: '面试',
    value: { rating: 4 },
    decision_id: first.decision_id,
    idempotency_key: `feature-snapshot:${suffix}`,
  });
  assert.equal(outcome.ok, true);
  return first;
}

test('0051：新推荐在同一行保存完整 ltr-feat-v1 快照', () => {
  const { db, run } = fixture();
  try {
    const columns = db.prepare('PRAGMA table_info(recommendations)').all().map((row) => row.name);
    assert.ok(columns.includes('feature_snapshot_json'));
    const rows = db.prepare(`SELECT feature_snapshot_json FROM recommendations
      WHERE run_id=?`).all(run.run_id);
    assert.ok(rows.length >= 20);
    for (const row of rows) {
      const parsed = readFeatureSnapshot(row.feature_snapshot_json);
      assert.equal(parsed.ok, true);
      assert.deepEqual(Object.keys(parsed.features), LTR_FEATURES);
    }
  } finally {
    db.close();
  }
});

test('LTR 导出只读冻结快照，职位后改不改变历史特征', () => {
  const { db, run } = fixture();
  try {
    const first = labelFirst(db, run, 'stable');
    const before = exportDataset(db, labelWindow());
    assert.equal(before.rows.length, 1);

    db.prepare(`UPDATE job_facts SET active_state='CLOSED', hc=999,
      pipeline='未来阶段,未来阶段2', notes='紧急急招' WHERE project_id=?`)
      .run(first.job.project_id);
    const after = exportDataset(db, labelWindow());
    assert.deepEqual(after.rows[0].features, before.rows[0].features);
    assert.equal(after.rows[0].features.state_open, 1);
    assert.notEqual(after.rows[0].features.hc, 999);
  } finally {
    db.close();
  }
});

test('旧推荐缺快照时明确排除，不回读当前 job_facts', () => {
  const { db, run } = fixture();
  try {
    const first = labelFirst(db, run, 'legacy');
    db.prepare(`UPDATE recommendations SET feature_snapshot_json=NULL
      WHERE decision_id=?`).run(first.decision_id);
    const dataset = exportDataset(db, labelWindow());
    assert.equal(dataset.rows.length, 0);
    assert.equal(dataset.excluded.MISSING_FEATURE_SNAPSHOT, 1);
  } finally {
    db.close();
  }
});

test('影子评估遇到缺失快照时不给出不可比较的 NDCG', () => {
  const { db, run } = fixture();
  try {
    const first = labelFirst(db, run, 'shadow');
    db.prepare(`UPDATE recommendations SET feature_snapshot_json=NULL
      WHERE decision_id=?`).run(first.decision_id);
    const shadowModel = { score: (features) => features.hc };
    const report = evaluate(db, { runs: 1, consultant_ids: ['felix'], shadowModel,
      ...labelWindow() });
    assert.equal(report.metrics.shadow_ndcg_at_10, null);
    assert.equal(report.groups_detail[0].shadow_excluded_reason, 'MISSING_FEATURE_SNAPSHOT');
    assert.equal(report.groups_detail[0].shadow_excluded_count, 1);
  } finally {
    db.close();
  }
});

test('损坏或错版本的特征快照有稳定排除原因', () => {
  assert.equal(readFeatureSnapshot('{').reason, 'INVALID_FEATURE_SNAPSHOT');
  assert.equal(readFeatureSnapshot(JSON.stringify({
    schema_version: 'ltr-feat-v0', captured_at: new Date().toISOString(), features: {},
  })).reason, 'FEATURE_SNAPSHOT_VERSION_MISMATCH');
});

test('影子分歧日报遇到缺失快照时整组排除', () => {
  const { db, run } = fixture();
  try {
    db.prepare(`UPDATE recommendations SET feature_snapshot_json=NULL
      WHERE decision_id=?`).run(run.items[0].decision_id);
    const result = divergenceTopN(db, { score: (features) => features.hc }, 'felix', {
      labelWindow: labelWindow(),
    });
    assert.equal(result.status, 'EXCLUDED');
    assert.equal(result.excluded.MISSING_FEATURE_SNAPSHOT, 1);
    assert.deepEqual(result.top, []);
  } finally {
    db.close();
  }
});
