import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { openDb, now, uuid } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { recordOutcome } from '../src/replay.js';
import { evaluate } from '../scripts/eval-ranking.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function rankedFixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const result = recommend(db, 'felix', { top: 20 });
  assert.ok(result.items.length >= 11, 'fixture 必须至少产生 11 条推荐');
  return { db, runId: result.run_id, items: result.items };
}

function dismiss(db, projectId, suffix) {
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, decision_id,
     policy_version, idempotency_key, prev_state, next_state, payload_json)
    VALUES (?, 'DISMISSED', 'felix', ?, ?, NULL, 'test', ?, 'VIEWED', 'DISMISSED', '{}')`)
    .run(uuid(), now(), projectId, `ranking-eval:${suffix}`);
}

test('NDCG@10 的 IDCG 来自完整评估组，而不是预测 Top10', () => {
  const { db, runId, items } = rankedFixture();
  try {
    recordOutcome(db, 'felix', {
      project_id: items[0].job.project_id,
      stage: '推荐',
      value: {},
      idempotency_key: 'ranking-eval:rank-1',
    });
    for (let i = 1; i < 10; i += 1) dismiss(db, items[i].job.project_id, `rank-${i + 1}`);
    recordOutcome(db, 'felix', {
      project_id: items[10].job.project_id,
      stage: 'Offer',
      value: {},
      idempotency_key: 'ranking-eval:rank-11',
    });

    const report = evaluate(db, { runs: 1, consultant_ids: ['felix'] });
    assert.equal(report.metric_version, 'ranking-metrics-v2');
    assert.ok(report.metrics.ndcg_at_10 > 0 && report.metrics.ndcg_at_10 < 0.3);
    assert.ok(report.metrics.label_coverage > 0 && report.metrics.label_coverage < 1);
    assert.match(report.note, /未知标签保留预测位置/);
  } finally {
    db.close();
  }
});

test('未知标签不会把预测第 11 名挤进 NDCG@10', () => {
  const { db, items } = rankedFixture();
  try {
    for (let i = 1; i < 10; i += 1) dismiss(db, items[i].job.project_id, `unknown-rank-${i + 1}`);
    recordOutcome(db, 'felix', {
      project_id: items[10].job.project_id,
      stage: 'Offer',
      value: {},
      idempotency_key: 'ranking-eval:unknown-rank-11',
    });

    const report = evaluate(db, { runs: 1, consultant_ids: ['felix'] });
    assert.equal(report.metrics.ndcg_at_10, 0);
  } finally {
    db.close();
  }
});

test('evaluate 使用调用方传入的 runs，而不是模块级命令行默认值', () => {
  const limits = [];
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM decision_runs/);
      return { all(_consultantId, limit) { limits.push(limit); return []; } };
    },
  };
  const report = evaluate(db, { runs: 2, consultant_ids: ['felix'] });
  assert.equal(report.groups, 0);
  assert.deepEqual(limits, [2]);
});

test('Python NDCG 按预测索引取标签，交换顺序会降低指标', () => {
  const script = [
    'from scripts.train_ltr import ndcg',
    'good = ndcg([2, 1], [3, 1], [2], 2)',
    'bad = ndcg([1, 2], [3, 1], [2], 2)',
    'assert good == 1.0, good',
    'assert 0 < bad < good, (good, bad)',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
