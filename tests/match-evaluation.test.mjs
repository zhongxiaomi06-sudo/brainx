import assert from 'node:assert/strict';
import test from 'node:test';
import { runShadowEvaluation } from '../src/talent-pipeline/evaluation.js';

test('shadow evaluation reports Recall@20 and NDCG@10 without changing production order', () => {
  const fixture = [{ case_id: 'job-1', production_order: ['a', 'b', 'c'],
    shadow_order: ['b', 'a', 'c'], labels: { a: 3, b: 2, c: 0 } }];
  const before = JSON.stringify(fixture[0].production_order);
  const report = runShadowEvaluation(fixture);
  assert.equal(report.mode, 'SHADOW');
  assert.equal(report.recall_at_20, 1);
  assert.ok(report.ndcg_at_10 > 0 && report.ndcg_at_10 < 1);
  assert.equal(JSON.stringify(fixture[0].production_order), before);
});

test('an empty evaluation set is rejected', () => {
  assert.throws(() => runShadowEvaluation([]), /EVALUATION_SET_EMPTY/);
});
