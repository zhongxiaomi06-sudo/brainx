/** 2026-08-24 审计修复回归：EXPIRED 死态出口 / NEW 可直接接单 / chatTs 带秒 NaN。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync, latestRealSync } from '../src/sync.js';
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

test('旧 EXPIRED 状态折叠为待开始，只保留直接跟进出口', () => {
  const db = openDb(':memory:');
  const pid = seedRecommended(db);
  // 直接落到 EXPIRED（模拟 90 天过期器产出）
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, decision_id, policy_version, idempotency_key, prev_state, next_state, payload_json)
    VALUES ('e1','EXPIRED',?,datetime('now'),?,NULL,'test','x1','WATCHED','EXPIRED','{}')`).run(CID, pid);
  assert.equal(currentState(db, CID, pid).state, 'VIEWED');
  assert.equal(engage(db, CID, pid, 'WATCH', { idempotency_key: `w2:${pid}` }).status, 400);
  assert.equal(engage(db, CID, pid, 'DISMISS', { idempotency_key: `d:${pid}` }).status, 400);
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

test('bridge-error 观测行不阻断推荐，降级信号随响应下发（2026-08-25）', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: CID });
  // 模拟上游限流：最新行是 bridge-error（complete=0）
  const later = new Date(Date.now() + 60000).toISOString(); // ISO 与生产写入格式一致（字典序比较前提）
  db.prepare(`INSERT INTO sync_runs
    (sync_id, consultant_id, source, as_of, rows_expected, rows_read, complete, errors, input_hash, started_at, completed_at)
    VALUES ('be1', ?, 'bridge-error', ?, 0, 0, 0, '["ttc:mia:-90429 服务繁忙"]', '', ?, ?)`)
    .run(CID, later, later, later);
  const out = recommend(db, CID, { top: 20 });
  assert.ok(!out.blocked, 'bridge-error 不得触发 fail-closed');
  assert.ok(out.sync_warning, '必须带降级信号');
  assert.match(out.sync_warning.message, /限流/); // 面向用户文案（2026-08-25 起不再透原始错误码）
  assert.match(out.sync_warning.detail, /90429/); // 原始错误进 detail 供排查
  // 真实同步视图仍指向 fixture 同步（complete=1）
  assert.equal(latestRealSync(db, CID).source, 'fixture');
});
