import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { registerFreeformDelivery } from '../src/sourcing-group-delivery.js';
import { createFreeformCandidateHandlers } from '../src/agent-gateway/tools-freeform-candidates.js';
import { rejectedCandidateRefs } from '../src/candidate-search-feedback.js';
import { freeformCandidateActions } from '../src/candidate-card-actions.js';
const p = { tenantId: 't', consultantId: 'felix', accountId: 'a', senderId: 'ou_me', chatType: 'group', chatId: 'oc_g' };
const search_key = 'supermai:0123456789ab';
const candidate_ref = 'PT123456789012';
function fixture(t) {
  const db = openDb(':memory:'); t.after(() => db.close());
  const at = now();
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('b','t','a',?,'ou_me','felix','ACTIVE',?,'test',?,?)`)
    .run(createHash('sha256').update('cli_test').digest('hex'), at, at, at);
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id,tenant_id,channel_account_id,chat_id,scope_status,allowed_purposes_json,created_at,updated_at)
    VALUES ('s','t','a','oc_g','ACTIVE','["candidate_review","candidate_action"]',?,?)`).run(at, at);
  const result = `<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [{ candidate_ref,
    name: '测试候选', role: '算法工程师', evaluation: '待核实', talent_url: null }] })}\n-->`;
  db.prepare(`INSERT INTO openmai_results(project_id,consultant_id,status,task_id,result_text,started_at)
    VALUES (?,'felix','done','sm_1',?,?)`).run(search_key, result, at);
  assert.equal(registerFreeformDelivery(db, p, search_key), true);
  const calls = [];
  const tools = createFreeformCandidateHandlers({ db, addTalentFn: async input => { calls.push(input); return { id: 1 }; } });
  const act = (action, principal = p, confirm = true) => tools.brainx_freeform_candidate_action({
    search_key, candidate_ref, action, confirm }, { principal });
  return { db, act, calls };
}
test('自由人选四动作有真实作用域，拒绝需确认且幂等，撤销有历史', async t => {
  const { db, act } = fixture(t);
  assert.equal(freeformCandidateActions({ search_key }, { candidateRef: candidate_ref }).length, 4);
  await assert.rejects(() => act('REJECT', p, false), /INVALID_ARGUMENT/);
  await act('REJECT'); await act('REJECT');
  assert.deepEqual(rejectedCandidateRefs(db, search_key, p), [candidate_ref]);
  assert.equal(db.prepare('SELECT count(*) n FROM freeform_candidate_events').get().n, 1);
  await act('RESTORE'); assert.deepEqual(rejectedCandidateRefs(db, search_key, p), []);
  const result = await act('SCREEN');
  assert.equal(result.data.status, 'SCREENED');
  assert.match(result.unknowns[0], /尚未关联职位/);
  assert.equal(db.prepare('SELECT count(*) n FROM freeform_candidate_events').get().n, 3);
});
test('猜搜索键不能跨账号、群、租户或顾问使用，撤权立即失效', async t => {
  const { db, act, calls } = fixture(t);
  for (const different of [{ accountId: 'b' }, { chatId: 'oc_other' }, { tenantId: 'other' }, { consultantId: 'mia' }]) {
    await assert.rejects(() => act('ADD_TO_RELOOP', { ...p, ...different }), /FORBIDDEN/);
  }
  assert.equal(calls.length, 0);
  db.exec("UPDATE feishu_identity_bindings SET binding_status='REVOKED'");
  await assert.rejects(() => act('SCREEN'), /FORBIDDEN/);
});
test('下一轮覆盖后旧卡仍可操作自己的冻结结果；真实入库失败不假称成功', async t => {
  const { db, act, calls } = fixture(t);
  db.exec("UPDATE openmai_results SET result_text='NO_REPLY',task_id='sm_2'");
  assert.equal((await act('ADD_TO_RELOOP')).data.status, 'added');
  assert.equal(calls[0].sourceRef, candidate_ref);
  const tools = createFreeformCandidateHandlers({ db, addTalentFn: async () => { throw new Error('secret'); } });
  const out = await tools.brainx_freeform_candidate_action({ search_key, candidate_ref, action: 'ADD_TO_RELOOP', confirm: true }, { principal: p });
  assert.equal(out.data.status, 'failed');
  assert.equal(out.data.sync_pending, false);
  assert.doesNotMatch(JSON.stringify(out), /secret/);
});
