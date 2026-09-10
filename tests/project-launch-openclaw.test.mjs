import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { confirmMembership } from '../src/membership.js';
import { launchProject } from '../src/project-launch.js';
import { startOpenclawGroupRetryWorker } from '../src/openclaw-group-retry.js';
import { describeAccessError } from '../src/openclaw-group-status.js';

const PID = 'P-OC-STATUS';
const PID2 = 'P-OC-STATUS-2';

function readyDb() {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: {
    as_of: now(), jobs: [
      { project_id: PID, company: '韬润', role: '业务助理', city: '上海',
        pipeline: '待推荐', hc: 1, active_state: 'OPEN', source_url: null, captured_at: now() },
      { project_id: PID2, company: '韬润', role: '商务助理', city: '上海',
        pipeline: '待推荐', hc: 1, active_state: 'OPEN', source_url: null, captured_at: now() },
    ],
  } });
  confirmMembership(db, 'felix', PID, { relation: 'MY_JOB', idempotency_key: 'join-oc' });
  confirmMembership(db, 'felix', PID2, { relation: 'MY_JOB', idempotency_key: 'join-oc-2' });
  const openId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('binding-oc','tenant-a','brainx-prod',?,?,'felix','ACTIVE',?,'system',?,?)`).run(
    'a'.repeat(64), openId, now(), now(), now(),
  );
  return db;
}

function deps({ onAllow = async () => {}, onSend = async () => ({ message_id: 'om_oc' }) } = {}) {
  return {
    appConfigured: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async (input) => ({
      chat_id: input.name.includes('商务') ? 'oc_second' : 'oc_status', name: input.name,
    }),
    ensureOpenClawGroupAllowed: onAllow,
    sendInteractiveCard: onSend,
  };
}

test('准入成功：群范围登记为 OK，不遗留 PENDING', async () => {
  const db = readyDb();
  const allowed = [];
  const result = await launchProject(db, 'felix', PID, { idempotency_key: 'oc-ok' },
    deps({ onAllow: async (chatId, senders) => allowed.push([chatId, senders.length]) }));
  assert.equal(result.openclaw.status, 'OK');
  assert.equal(result.launch.status, 'READY');
  assert.deepEqual(allowed, [['oc_status', 1]]);
  const row = db.prepare('SELECT * FROM project_launches').get();
  assert.equal(row.openclaw_status, 'OK');
  assert.equal(row.openclaw_error, null);
  assert.equal(row.message_id, 'om_oc');
  db.close();
});

test('发卡失败：整条失败但保留 chat_id 供重放，error_code 为投放失败', async () => {
  const db = readyDb();
  await assert.rejects(launchProject(db, 'felix', PID, { idempotency_key: 'oc-send-fail' },
    deps({ onSend: async () => { throw new Error('FEISHU_SEND_FAILED: 230098'); } })),
  (error) => error.code === 'FEISHU_JOB_POST_FAILED');
  const row = db.prepare('SELECT * FROM project_launches').get();
  assert.equal(row.status, 'FAILED');
  assert.equal(row.chat_id, 'oc_status');
  assert.equal(row.openclaw_status, 'PENDING', '准入尚未尝试，重放时应补齐');
  assert.match(row.error_message, /FEISHU_SEND_FAILED/);
  db.close();
});

test('补偿任务：PENDING 重放成功后触发一次 gateway 重启，节流内不重复重启', async () => {
  const db = readyDb();
  await launchProject(db, 'felix', PID, { idempotency_key: 'oc-pending-1' },
    deps({ onAllow: async () => { throw new Error('boom'); } }));
  const second = await launchProject(db, 'felix', PID2, { idempotency_key: 'oc-pending-2' },
    deps({ onAllow: async () => { throw new Error('boom'); } }));
  assert.equal(second.openclaw.status, 'PENDING');
  const attempts = [];
  const restarts = [];
  const worker = startOpenclawGroupRetryWorker(db, {
    runImmediately: false,
    ensureGroup: async (chatId) => { attempts.push(chatId); },
    restartGateway: async () => { restarts.push(Date.now()); return { ok: true }; },
    restartMinIntervalMs: 60_000,
  });
  await worker.sweep();
  assert.deepEqual(new Set(attempts), new Set(['oc_status', 'oc_second']));
  assert.equal(restarts.length, 1, '一轮内多个群恢复只重启一次');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM project_launches WHERE openclaw_status='PENDING'").get().c, 0);
  await worker.sweep();
  assert.equal(attempts.length, 2, '已 OK 的群不再重放');
  worker.stop();
  db.close();
});

test('补偿任务：重试耗尽转 FAILED 并保留最后错误', async () => {
  const db = readyDb();
  await launchProject(db, 'felix', PID, { idempotency_key: 'oc-pending-2' },
    deps({ onAllow: async () => { throw new Error('boom'); } }));
  let restarts = 0;
  const worker = startOpenclawGroupRetryWorker(db, {
    runImmediately: false, maxAttempts: 3,
    ensureGroup: async () => {
      throw { code: 'OPENCLAW_GROUP_ALLOWLIST_FAILED',
        options: { cause: { code: 'OPENCLAW_TIMEOUT', stderr: 'boom' } } };
    },
    restartGateway: async () => { restarts += 1; return { ok: true }; },
  });
  await worker.sweep();
  await worker.sweep();
  const row = db.prepare('SELECT * FROM project_launches').get();
  assert.equal(row.openclaw_status, 'FAILED');
  assert.match(row.openclaw_error, /OPENCLAW_GROUP_ALLOWLIST_FAILED: OPENCLAW_TIMEOUT/);
  assert.equal(restarts, 0, '准入未恢复不得重启 gateway');
  worker.stop();
  db.close();
});

test('错误描述：带出 cause 与 stderr 末行，且不泄露超长输出', () => {
  const timeout = { code: 'OPENCLAW_GROUP_ALLOWLIST_FAILED',
    options: { cause: { code: 'OPENCLAW_TIMEOUT', stderr: 'noise\nfinal line' } } };
  assert.equal(describeAccessError(timeout), 'OPENCLAW_GROUP_ALLOWLIST_FAILED: OPENCLAW_TIMEOUT final line');
  const exit = { code: 'OPENCLAW_GROUP_ALLOWLIST_FAILED',
    options: { cause: { exitCode: 1, stderr: 'EACCES denied' } } };
  assert.equal(describeAccessError(exit), 'OPENCLAW_GROUP_ALLOWLIST_FAILED: exit=1 EACCES denied');
  assert.equal(describeAccessError(new Error('plain')), 'Error');
  assert.equal(describeAccessError(undefined), 'UNKNOWN');
  assert.ok(describeAccessError({ code: 'X', options: { cause: { stderr: 'y'.repeat(500) } } }).length <= 240);
});
