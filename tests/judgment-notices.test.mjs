import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDb, now } from '../src/db.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { produceOne } from '../src/job-extract/bridge-producer.js';
import { consumeJudgmentExtract } from '../src/judgment-extract/index.js';
import { deliverJudgmentNoticesOnce } from '../src/judgment-extract/notices.js';
import { createJudgmentToolHandlers } from '../src/agent-gateway/tools-judgments.js';
import { createSearchStartNoticeHandler } from '../plugins/brainx-openclaw/search-start-notice.js';

async function fixture(t) {
  const db = openDb(':memory:'); t.after(() => db.close()); const at = now();
  registerChatContext(db, { chat_id: 'oc_g', bot_mode: 'ALL' });
  const event = await produceOne(db, { message_id: 'm1', chat_id: 'oc_g', text: '星曜科技说：只要算法工程师', create_time: at });
  consumeJudgmentExtract(db, event.event_id);
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('b','t','a',?,'ou_me','felix','ACTIVE',?,'test',?,?)`)
    .run(createHash('sha256').update('cli').digest('hex'), at, at, at);
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id,tenant_id,channel_account_id,chat_id,scope_status,allowed_purposes_json,created_at,updated_at)
    VALUES ('s','t','a','oc_g','ACTIVE','["candidate_review","job_fact_review"]',?,?)`).run(at, at);
  db.prepare("INSERT INTO consultant_chats (consultant_id,chat_id,name,seen_at) VALUES ('felix','oc_g','测试',?)").run(at);
  return db;
}
test('默认不打扰，开启后只发原群一次，记下来才转正、不启动搜索', async t => {
  const db = await fixture(t); const sent = [];
  const deps = { enabled: true, appId: 'cli', sendCardFn: async input => { sent.push(input); } };
  assert.equal((await deliverJudgmentNoticesOnce(db, { ...deps, enabled: false })).sent, 0);
  assert.equal((await deliverJudgmentNoticesOnce(db, deps)).sent, 1);
  assert.equal(sent[0].target, 'oc_g');
  assert.equal((await deliverJudgmentNoticesOnce(db, deps)).sent, 0);
  const draft = db.prepare('SELECT * FROM judgment_drafts').get();
  assert.equal(draft.status, 'pending');
  const review = createJudgmentToolHandlers({ db }).brainx_review_judgment;
  const args = { draft_id: draft.draft_id, action: 'confirm', confirm: true };
  assert.throws(() => review(args, { principal: { consultantId: 'felix', chatType: 'group', chatId: 'oc_other' } }), /FORBIDDEN/);
  assert.equal(review(args, { principal: { consultantId: 'felix', chatType: 'group', chatId: 'oc_g' } }).data.status, 'confirmed');
  assert.equal(db.prepare('SELECT count(*) n FROM openmai_results').get().n, 0);
});
test('失败重试仅发送卡，权限撤回/错误应用/静默群均不发送', async t => {
  const db = await fixture(t); let calls = 0;
  const deps = { enabled: true, appId: 'cli', sendCardFn: async () => { calls++; throw new Error('private'); } };
  assert.equal((await deliverJudgmentNoticesOnce(db, { ...deps, appId: 'wrong' })).sent, 0);
  assert.equal((await deliverJudgmentNoticesOnce(db, deps)).failed, 1);
  await deliverJudgmentNoticesOnce(db, deps); assert.equal(calls, 1);
  db.exec("UPDATE chat_contexts SET bot_mode='MENTION_ONLY'");
  await deliverJudgmentNoticesOnce(db, { ...deps, at: new Date(Date.now() + 120_000).toISOString() });
  assert.equal(calls, 1);
  db.exec("UPDATE chat_contexts SET bot_mode='ALL'; UPDATE agent_group_scopes SET allowed_purposes_json='[]'");
  await deliverJudgmentNoticesOnce(db, { ...deps, at: new Date(Date.now() + 120_000).toISOString() });
  assert.equal(calls, 1);
});
test('需求找人按钮按结构化条件确定性直调，重复回调只执行一次', async () => {
  const calls = [];
  const api = { runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async () => {} }) } } } };
  const hook = createSearchStartNoticeHandler(api, { gatewayToken: 't'.repeat(40), assertionSecret: 's'.repeat(40),
    fetchImpl: async (_url, opts) => { calls.push(JSON.parse(opts.body).arguments); return { json: async () => ({ ok: true, data: { status: 'triggered' } }) }; } });
  const event = { content: '[BRAINTEX_FREEFORM_START] {"criteria":"上海算法工程师","continue_search":false}', senderId: 'ou_me', messageId: 'm' };
  const context = { channelId: 'feishu', accountId: 'a', conversationId: 'oc_g' };
  await hook(event, context); await hook(event, context);
  assert.deepEqual(calls, [{ criteria: '上海算法工程师', continue_search: false }]);
});
