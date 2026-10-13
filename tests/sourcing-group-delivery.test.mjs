import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { settleOpenmaiTask } from '../src/openmai-task.js';
import { registerFreeformDelivery, deliverFreeformResultsOnce } from '../src/sourcing-group-delivery.js';

const principal = { tenantId: 'tenant', consultantId: 'felix', accountId: 'app',
  senderId: 'ou_user', chatType: 'group', chatId: 'oc_group' };
const appKeyHash = createHash('sha256').update('test_app_secret').digest('hex');
function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  const at = now();
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('binding','tenant','app',?,'ou_user','felix','ACTIVE',?,'test',?,?)`)
    .run(appKeyHash, at, at, at);
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id,tenant_id,channel_account_id,chat_id,scope_status,allowed_purposes_json,created_at,updated_at)
    VALUES ('scope','tenant','app','oc_group','ACTIVE','["candidate_review"]',?,?)`).run(at, at);
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,task_id,started_at,search_brief,search_round,excluded_candidate_refs_json)
    VALUES ('supermai:test','felix','running','sm_test',?,'上海算法工程师',2,'["external:1"]')`).run(at);
  return db;
}
function settle(db, status = 'done', resultText = '未找到匹配候选人') {
  return settleOpenmaiTask(db, { projectId: 'supermai:test', consultantId: 'felix',
    taskId: 'sm_test', status, resultText, error: status === 'failed' ? '上游不可用' : null });
}
const row = db => db.prepare('SELECT * FROM sourcing_group_deliveries').get();

test('冻结每轮终态，下一轮覆盖后仍送原群；重复运行不会重发', async t => {
  const db = fixture(t);
  assert.equal(registerFreeformDelivery(db, principal, 'supermai:test'), true);
  registerFreeformDelivery(db, principal, 'supermai:test');
  assert.equal(db.prepare('SELECT count(*) n FROM sourcing_group_deliveries').get().n, 1);
  assert.equal(settle(db), true);
  db.prepare("UPDATE openmai_results SET task_id='sm_next',search_brief='北京产品',status='running'").run();
  const sent = [];
  const deps = { appKeyHash, sendInteractiveCard: async input => { sent.push(input); return { message_id: 'm1' }; } };
  assert.equal((await deliverFreeformResultsOnce(db, deps)).sent, 1);
  assert.equal(sent[0].target, 'oc_group');
  assert.match(JSON.stringify(sent[0].card), /上海算法工程师/);
  assert.doesNotMatch(JSON.stringify(sent[0].card), /北京产品/);
  assert.equal(row(db).message_id, 'm1');
  assert.equal((await deliverFreeformResultsOnce(db, deps)).sent, 0);
});

for (const status of ['needs_input', 'failed', 'done']) {
  test(`${status} 终态可恢复投递，联系方式不出现在群卡`, async t => {
    const db = fixture(t);
    registerFreeformDelivery(db, principal, 'supermai:test');
    settle(db, status, status === 'done' ? 'NO_REPLY' : '请补充条件，电话 13812345678');
    let card;
    await deliverFreeformResultsOnce(db, { appKeyHash, sendInteractiveCard: async input => {
      card = input.card; return { message_id: 'm' };
    } });
    assert.equal(row(db).delivery_status, 'SENT');
    assert.doesNotMatch(JSON.stringify(card), /13812345678|NO_REPLY/);
  });
}

test('发送失败只重试卡片且稳定幂等键，最多五次', async t => {
  const db = fixture(t);
  registerFreeformDelivery(db, principal, 'supermai:test');
  settle(db);
  const ids = [];
  const sendInteractiveCard = async input => { ids.push(input.idempotencyKey); throw new Error('secret'); };
  for (let i = 0; i < 7; i++) {
    await deliverFreeformResultsOnce(db, { appKeyHash, sendInteractiveCard,
      at: new Date(Date.now() + i * 600_000).toISOString() });
  }
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 1);
  assert.equal(row(db).attempts, 5);
  assert.equal(row(db).last_error, 'DELIVERY_FAILED');
});

for (const revoke of ["UPDATE feishu_identity_bindings SET binding_status='REVOKED'",
  "UPDATE agent_group_scopes SET allowed_purposes_json='[]'",
  "UPDATE agent_group_scopes SET tenant_id='other'"]) {
  test(`投递前重新鉴权：${revoke}`, async t => {
    const db = fixture(t);
    registerFreeformDelivery(db, principal, 'supermai:test');
    settle(db);
    db.exec(revoke);
    const result = await deliverFreeformResultsOnce(db, { appKeyHash,
      sendInteractiveCard: async () => assert.fail('不能向已撤权群发送') });
    assert.equal(result.cancelled, 1);
  });
}

test('跨租户不登记；默认应用不匹配不发送', async t => {
  const db = fixture(t);
  assert.equal(registerFreeformDelivery(db, { ...principal, tenantId: 'other' }, 'supermai:test'), false);
  registerFreeformDelivery(db, principal, 'supermai:test');
  settle(db);
  await deliverFreeformResultsOnce(db, { appKeyHash: createHash('sha256').update('wrong').digest('hex'),
    sendInteractiveCard: async () => assert.fail('不能使用错误应用') });
  assert.equal(row(db).last_error, 'DELIVERY_APP_MISMATCH');
});

test('重启后的超时任务诚实报失败；中断发送恢复原幂等键', async t => {
  const db = fixture(t);
  registerFreeformDelivery(db, principal, 'supermai:test');
  const at = new Date(Date.now() + 2 * 3600_000).toISOString();
  const sent = [];
  const deps = { appKeyHash, at, sendInteractiveCard: async input => { sent.push(input); return {}; } };
  await deliverFreeformResultsOnce(db, deps);
  assert.equal(row(db).result_status, 'failed');
  assert.match(JSON.stringify(sent[0].card), /中断或超时/);
  db.exec("UPDATE sourcing_group_deliveries SET delivery_status='SENDING',updated_at='2020-01-01T00:00:00.000Z'");
  await deliverFreeformResultsOnce(db, deps);
  assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
});
