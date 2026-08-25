/** 2026-08-24 审计修复回归：EXPIRED 死态出口 / NEW 可直接接单 / chatTs 带秒 NaN。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { engage, currentState } from '../src/engagement.js';
import { scoreJob } from '../src/scorer.js';

const CID = 'felix';

function seedRecommended(db) {
  runSync(db, { source: 'fixture', consultant_id: CID });
  const out = recommend(db, CID, { top: 20 });
  assert.ok(!out.blocked);
  return out.items[0].job.project_id;
}

test('EXPIRED 死态有出口：WATCH / ACCEPT / DISMISS 不再 409', () => {
  const db = openDb(':memory:');
  const pid = seedRecommended(db);
  engage(db, CID, pid, 'WATCH', { idempotency_key: `w:${pid}` });
  // 直接落到 EXPIRED（模拟 90 天过期器产出）
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, decision_id, policy_version, idempotency_key, prev_state, next_state, payload_json)
    VALUES ('e1','EXPIRED',?,datetime('now'),?,NULL,'test','x1','WATCHED','EXPIRED','{}')`).run(CID, pid);
  assert.equal(currentState(db, CID, pid).state, 'EXPIRED');
  const reWatch = engage(db, CID, pid, 'WATCH', { idempotency_key: `w2:${pid}` });
  assert.ok(reWatch.ok, `EXPIRED→WATCH 应允许: ${reWatch.error}`);
  const acc = engage(db, CID, pid, 'ACCEPT', { idempotency_key: `a:${pid}`, confirm: true });
  assert.ok(acc.ok, `EXPIRED→ACCEPT 应允许: ${acc.error}`);
});

test('NEW 状态可直接 ACCEPT（未触碰推荐不再强制先关注）', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: CID });
  const pid = db.prepare('SELECT project_id FROM job_facts LIMIT 1').get().project_id;
  assert.equal(currentState(db, CID, pid).state, 'NEW');
  const acc = engage(db, CID, pid, 'ACCEPT', { idempotency_key: `na:${pid}`, confirm: true });
  assert.ok(acc.ok, `NEW→ACCEPT 应允许: ${acc.error}`);
  assert.equal(currentState(db, CID, pid).state, 'ACCEPTED');
});

test('chatTs 带秒格式（HH:mm:ss）不再静默掉 20 分', () => {
  const withSeconds = { company: 'X', role: 'Y', active_state: 'OPEN',
    chat_last_at: new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 19).replace('T', ' '), // 2 天前带秒
    captured_at: new Date().toISOString() };
  const ctx = { profile_keywords: [], historical_texts: [], consultant_id: 't', now: new Date().toISOString() };
  const scored = scoreJob(withSeconds, 'TEAM_SHARED', ctx);
  const act = scored.breakdown.find((d) => d.dim === 'activity').score;
  // 2 天前群活跃：指数衰减 20+45·e^(-2/14) ≈ 58.9，NaN 路径则恒 20
  assert.ok(act > 50, `带秒格式活跃度被静默打到 20: ${act}`);
});
