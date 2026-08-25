/** 2026-08-25 披露层修正回归：规则页滑杆接真 policy（六维权重覆盖）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend, buildCtx } from '../src/recommend.js';
import { updateProfile } from '../src/roster.js';
import { normalizeWeights, WEIGHTS, scoreJob } from '../src/scorer.js';

const CID = 'felix';

test('normalizeWeights：百分比归一 / 未知维度与全零拒绝 / 空对象回基线', () => {
  // 语义：未给维沿用基线后整体归一（0.5/1.55 ≈ 0.323）
  const v = normalizeWeights({ direction: 50, activity: 50 });
  assert.ok(v.ok);
  assert.ok(Math.abs(v.weights.direction - 0.5 / 1.55) < 0.01);
  assert.ok(Math.abs(Object.values(v.weights).reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.equal(normalizeWeights({ direction: 0, activity: 0, similarity: 0, capacity: 0, outcomes: 0, exploration: 0 }).ok, false);
  assert.equal(normalizeWeights({ bogus: 10 }).ok, false);
  assert.equal(normalizeWeights({}).weights, null); // 空对象 = 恢复基线
  assert.equal(normalizeWeights(null).weights, null);
});

test('updateProfile：保存 weights 生效且不擦掉 capacity_limit；非法值 422', () => {
  const db = openDb(':memory:');
  db.prepare(`UPDATE consultants SET profile_json=? WHERE consultant_id=?`)
    .run(JSON.stringify({ profile_keywords: ['增长'], capacity_limit: 6 }), CID);
  const out = updateProfile(db, CID, { weights: { direction: 60, exploration: 40 } });
  assert.ok(out.ok, out.error);
  assert.ok(out.weights.direction > 0.3, `direction=0.6/1.65≈0.36: ${out.weights.direction}`);
  const raw = JSON.parse(db.prepare('SELECT profile_json FROM consultants WHERE consultant_id=?').get(CID).profile_json);
  assert.equal(raw.capacity_limit, 6, 'capacity_limit 必须保留');
  assert.deepEqual(raw.profile_keywords, ['增长'], '画像关键词必须保留');
  assert.equal(updateProfile(db, CID, { weights: { bogus: 1 } }).status, 422);
  // 恢复基线
  const back = updateProfile(db, CID, { weights: {} });
  assert.equal(back.weights, null);
  const raw2 = JSON.parse(db.prepare('SELECT profile_json FROM consultants WHERE consultant_id=?').get(CID).profile_json);
  assert.equal(raw2.weights, undefined);
  assert.equal(raw2.capacity_limit, 6);
});

test('scoreJob：自定义权重改变总分与 breakdown 权重展示', () => {
  const job = { company: '云帆', role: '增长负责人', active_state: 'OPEN', captured_at: new Date().toISOString() };
  const ctx = { profile_keywords: ['增长'], historical_texts: [], consultant_id: 't', now: new Date().toISOString() };
  const base = scoreJob(job, 'TEAM_SHARED', ctx);
  const custom = scoreJob(job, 'TEAM_SHARED', { ...ctx, weights: normalizeWeights({ direction: 90, exploration: 10 }).weights });
  const wBase = base.breakdown.find((d) => d.dim === 'direction').weight;
  const wCustom = custom.breakdown.find((d) => d.dim === 'direction').weight;
  assert.equal(wBase, WEIGHTS.direction);
  assert.ok(wCustom > 0.5, `自定义 direction 权重应 ~0.55: ${wCustom}`);
  assert.notEqual(base.score, custom.score);
});

test('端到端：PUT weights 后 buildCtx 生效，recommend 按新权重出分', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: CID });
  updateProfile(db, CID, { weights: { direction: 70, activity: 30 } });
  const ctx = buildCtx(db, CID, null);
  assert.ok(ctx.weights, 'buildCtx 应携带自定义权重');
  assert.ok(ctx.weights.direction > 0.4);
  const out = recommend(db, CID, { top: 20 });
  assert.ok(!out.blocked);
  const w = out.items[0].breakdown.find((d) => d.dim === 'direction').weight;
  assert.ok(w > 0.4, `冻结推荐的 breakdown 应反映自定义权重: ${w}`);
});
