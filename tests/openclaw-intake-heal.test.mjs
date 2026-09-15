/** openclaw-intake-heal.test.mjs — intake 旧群 OpenClaw 白名单自愈。
 * 背景：LD-荆华密算-销售、LD-Unipat-销售 等 intake 群 CARD_SENT 多天却不在
 * groupAllowFrom（加白结果被静默丢弃、无账本可重放），@机器人被 allowlist
 * 策略丢弃；且配置可能被运维回滚，需要周期性自愈。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { startOpenclawGroupRetryWorker, healIntakeGroups } from '../src/openclaw-group-retry.js';

function seedIntake(db) {
  const insert = db.prepare(`INSERT INTO bot_chat_intake
    (chat_id, chat_name, status, first_seen_at, updated_at) VALUES (?,?,?,?,?)`);
  insert.run('oc_seen', '旧群A', 'SEEN', now(), now());
  insert.run('oc_card', '旧群B', 'CARD_SENT', now(), now());
  insert.run('oc_bound', '旧群C', 'BOUND', now(), now());
  insert.run('oc_skip', '死群', 'SKIPPED', now(), now());
}

function workerFor(db, { ensureGroup, restartGateway, ...rest } = {}) {
  const restarts = [];
  const worker = startOpenclawGroupRetryWorker(db, {
    runImmediately: false,
    ensureGroup,
    restartGateway: restartGateway || (async () => { restarts.push(1); return { ok: true }; }),
    ...rest,
  });
  return { worker, restarts };
}

test('intake 自愈：SEEN/CARD_SENT/BOUND 都被 ensure，SKIPPED 死群不碰', async () => {
  const db = openDb(':memory:');
  seedIntake(db);
  const ensured = [];
  const { worker } = workerFor(db, {
    ensureGroup: async (chatId, senders) => {
      ensured.push([chatId, senders]);
      return { added: false, sender_added: 0 };
    },
  });
  await worker.sweep();
  assert.deepEqual(ensured.map(([chatId]) => chatId), ['oc_bound', 'oc_card', 'oc_seen']);
  assert.ok(ensured.every(([, senders]) => Array.isArray(senders) && senders.length === 0),
    'intake 群不附带 sender 名单');
  worker.stop();
  db.close();
});

test('intake 自愈：added>0 整轮只触发一次节流重启；added=0 不重启', async () => {
  const db = openDb(':memory:');
  seedIntake(db);
  let added = true;
  const { worker, restarts } = workerFor(db, {
    ensureGroup: async () => ({ added, sender_added: 0 }),
  });
  await worker.sweep();
  assert.equal(restarts.length, 1, '三群补白整轮只重启一次');
  await worker.sweep();
  assert.equal(restarts.length, 1, '默认节流（15 分钟）内重复补白不重复重启');
  added = false;
  const quiet = workerFor(db, { ensureGroup: async () => ({ added: false, sender_added: 0 }) });
  await quiet.worker.sweep();
  assert.equal(quiet.restarts.length, 0, '已在白名单（added=0）不重启');
  worker.stop();
  quiet.worker.stop();
  db.close();
});

test('intake 自愈：单群 ensure 抛错不影响其他群，也不中断 sweep', async () => {
  const db = openDb(':memory:');
  seedIntake(db);
  const ensured = [];
  const { worker, restarts } = workerFor(db, {
    ensureGroup: async (chatId) => {
      if (chatId === 'oc_card') throw new Error('OPENCLAW_TIMEOUT');
      ensured.push(chatId);
      return { added: true, sender_added: 0 };
    },
  });
  await worker.sweep(); // 不抛错即完成整轮
  assert.deepEqual(ensured, ['oc_bound', 'oc_seen'], '失败群跳过，其余群照常 ensure');
  assert.equal(restarts.length, 1, '有群实际补白仍按节流重启');
  worker.stop();
  db.close();
});

test('healIntakeGroups 单元：added 兼容 boolean/number，失败计数', async () => {
  const out = await healIntakeGroups(['oc_a', 'oc_b', 'oc_c'], async (chatId) => {
    if (chatId === 'oc_a') return { added: 1 };
    if (chatId === 'oc_b') throw new Error('boom');
    return { added: false };
  });
  assert.deepEqual(out, { healed: 1, failures: 1 });
});

test('launch PENDING 原有行为不回归：重放成功 OK 并重启，intake 自愈同轮顺带跑', async () => {
  const db = openDb(':memory:');
  // 手工落一条 PENDING launch（不依赖 launchProject 全链路；consultants 由 roster 种子覆盖）
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES ('sync-x', 'felix', 'test', ?, 'h', ?)`).run(now(), now());
  db.prepare(`INSERT INTO job_facts (project_id, company, role, active_state, captured_at, sync_id, raw_json, updated_at)
    VALUES ('P-RETRY', '韬润', '业务助理', 'OPEN', ?, 'sync-x', '{}', ?)`).run(now(), now());
  db.prepare(`INSERT INTO project_launches
    (launch_id, consultant_id, project_id, idempotency_key, status, current_step, chat_id,
     openclaw_status, created_at, updated_at)
    VALUES ('l-retry', 'felix', 'P-RETRY', 'k-retry', 'READY', 'READY', 'oc_launch', 'PENDING', ?, ?)`)
    .run(now(), now());
  seedIntake(db);
  const ensured = [];
  const { worker, restarts } = workerFor(db, {
    ensureGroup: async (chatId) => { ensured.push(chatId); return { added: false, sender_added: 0 }; },
  });
  await worker.sweep();
  assert.equal(db.prepare("SELECT openclaw_status FROM project_launches WHERE launch_id='l-retry'")
    .get().openclaw_status, 'OK', 'PENDING 重放成功转 OK');
  assert.ok(ensured.includes('oc_launch') && ensured.includes('oc_seen'), 'launch 与 intake 同轮 ensure');
  assert.equal(restarts.length, 1, 'launch PENDING 恢复按既有逻辑重启一次；intake added=0 不再额外重启');
  worker.stop();
  db.close();
});
