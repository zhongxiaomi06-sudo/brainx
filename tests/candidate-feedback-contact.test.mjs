import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createCandidateActionToolHandlers } from '../src/agent-gateway/tools-candidate-actions.js';
import { nextSearchExclusions, nextSupermaiSearchExclusions } from '../src/search-rounds.js';
import { sendCandidatePrivateContact } from '../src/agent-gateway/candidate-private-contact.js';
import { rejectCandidateAction } from '../src/candidate-card-actions.js';

const principal = { tenantId: 't1', consultantId: 'felix', accountId: 'a1', senderId: 'ou_me', chatType: 'group', chatId: 'oc_group' };
function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const handlers = createCandidateActionToolHandlers({ db, candidateShortlistFn: async () => ({
    items: [{ candidate_ref: 'PL1234567890' }], page: { next_page_token: null },
  }) });
  return { db, jobId, act: (action, confirm = true) => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'PL1234567890', action, confirm, note: '技能不匹配',
  }, { principal }) };
}

test('拒绝需确认，重复幂等、个人项目隔离、撤销可回放', async t => {
  const { db, jobId, act } = fixture(t);
  await assert.rejects(() => act('REJECT_CANDIDATE', false), /INVALID_ARGUMENT/);
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_search_feedback_events').get().n, 0);
  await act('REJECT_CANDIDATE');
  await act('REJECT_CANDIDATE');
  for (const select of [nextSearchExclusions, nextSupermaiSearchExclusions]) {
    assert.deepEqual(select(db, jobId, principal), ['PL1234567890']);
    assert.deepEqual(select(db, jobId, { ...principal, tenantId: 't2' }), []);
    assert.deepEqual(select(db, jobId, { ...principal, consultantId: 'mia' }), []);
    assert.deepEqual(select(db, 'other', principal), []);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_search_feedback_events').get().n, 1);
  await act('RESTORE_CANDIDATE');
  assert.deepEqual(nextSearchExclusions(db, jobId, principal), []);
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_search_feedback_events').get().n, 2);
});

test('不合适按钮声明二次确认，取消不会携带写操作', () => {
  const button = rejectCandidateAction({ project_id: 'P1' }, { candidateRef: 'PL1234567890' });
  assert.match(button.confirm.title.content, /确认/);
  assert.match(button.value.text, /REJECT_CANDIDATE/);
});

const keyHash = createHash('sha256').update('test_app_key').digest('hex');
const wrongKeyHash = createHash('sha256').update('wrong_app_key').digest('hex');
function binding(db) {
  const at = now();
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
    binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('b','t1','a1',?,'ou_me','felix','ACTIVE',?,'test',?,?)`)
    .run(keyHash, at, at, at);
}
test('联系方式只私发可信发起人，不回群或工具返回；发送失败不假称送达', async t => {
  const { db } = fixture(t);
  binding(db);
  const sent = [];
  const deps = { appKeyHash: keyHash, loadCandidateContactFn: async input => {
    assert.equal(input.tenantId, 't1'); assert.equal(input.consultantId, 'felix');
    return { phone: '13812345678', email: 'example@example.com' };
  }, sendTextMessageFn: async input => { sent.push(input); } };
  const out = await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps);
  assert.equal(out.data.contact_delivery, 'sent');
  assert.equal(sent[0].target, 'ou_me');
  assert.match(sent[0].text, /13812345678/);
  assert.doesNotMatch(JSON.stringify(out), /13812345678|example@example/);
  const failed = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, sendTextMessageFn: async () => { throw new Error('private secret'); },
  });
  assert.equal(failed.data.contact_delivery, 'failed');
  assert.doesNotMatch(JSON.stringify(failed), /private secret|13812345678/);
});
test('撤权或应用不匹配时不读取；无电话与无授权区分', async t => {
  const { db } = fixture(t);
  binding(db);
  const deps = { appKeyHash: wrongKeyHash, loadCandidateContactFn: async () => assert.fail('不能读取'),
    sendTextMessageFn: async () => assert.fail('不能发送') };
  assert.equal((await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps)).data.contact_delivery, 'unavailable');
  const pending = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash, loadCandidateContactFn: async () => ({ phone: null, email: null }),
  });
  assert.equal(pending.data.contact_delivery, 'pending');
  const denied = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash, loadCandidateContactFn: async () => {
      throw Object.assign(new Error('NOT_FOUND_OR_FORBIDDEN'), { code: 'NOT_FOUND_OR_FORBIDDEN' });
    },
  });
  assert.equal(denied.data.contact_delivery, 'not_authorized');
  db.exec("UPDATE feishu_identity_bindings SET binding_status='REVOKED'");
  assert.equal((await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash,
  })).data.contact_delivery, 'unavailable');
});
