import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';
import { consumeJobExtract } from '../src/job-extract/index.js';
import { createJobFactsToolHandlers } from '../src/agent-gateway/tools-job-facts.js';

function addMembership(db, consultantId, chatId) {
  db.prepare(`INSERT INTO consultant_chats (consultant_id, chat_id, name, seen_at)
    VALUES (?, ?, '测试群', ?)`).run(consultantId, chatId, new Date().toISOString());
}

function addDraft(db, chatId, messageId, text) {
  processLarkEvent(db, {
    message_id: messageId, chat_id: chatId, open_id: 'ou_sender', mentions: [],
    message_type: 'text', create_time: '2026-09-03T12:00:00+08:00', body: { text },
  });
  const event = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?')
    .get(`lark:message:${messageId}`);
  consumeJobExtract(db, event.event_id);
  return db.prepare('SELECT * FROM job_facts_drafts WHERE message_id=?').get(messageId);
}

function principal(consultantId) {
  return { consultantId, tenantId: 'tenant-a', accountId: 'braintex-prod', chatType: 'p2p' };
}

test('只列出本人所在且已登记群的 pending 草稿', () => {
  const db = openDb(':memory:');
  registerChatContext(db, { chat_id: 'oc_allowed', bot_mode: 'ALL' });
  registerChatContext(db, { chat_id: 'oc_other', bot_mode: 'ALL' });
  addMembership(db, 'felix', 'oc_allowed');
  addMembership(db, 'linda', 'oc_other');
  addDraft(db, 'oc_allowed', 'om_allowed', '星曜科技急招后端工程师，base 上海');
  addDraft(db, 'oc_other', 'om_other', '远航科技急招产品经理，base 北京');

  const tools = createJobFactsToolHandlers({ db });
  const out = tools.brainx_pending_job_facts({ limit: 20 }, { principal: principal('felix') });
  assert.equal(out.data.items.length, 1);
  assert.equal(out.data.items[0].company, '星曜科技');
  assert.equal(out.data.items[0].chat_id, undefined);
  assert.deepEqual(out.next_allowed_actions, ['brainx_review_job_fact']);
});

test('未登记群和 inactive 顾问均看不到草稿', () => {
  const db = openDb(':memory:');
  registerChatContext(db, { chat_id: 'oc_unregistered', bot_mode: 'ALL' });
  addMembership(db, 'felix', 'oc_unregistered');
  addDraft(db, 'oc_unregistered', 'om_unregistered', '云图科技急招算法工程师');
  db.prepare("DELETE FROM chat_contexts WHERE chat_id='oc_unregistered'").run();
  const tools = createJobFactsToolHandlers({ db });
  assert.equal(tools.brainx_pending_job_facts({}, { principal: principal('felix') }).data.items.length, 0);
  db.prepare("UPDATE consultants SET active=0 WHERE consultant_id='felix'").run();
  assert.equal(tools.brainx_pending_job_facts({}, { principal: principal('felix') }).data.items.length, 0);
});

test('本人显式确认后转正，跨群裁决默认拒绝', () => {
  const db = openDb(':memory:');
  registerChatContext(db, { chat_id: 'oc_felix', bot_mode: 'ALL' });
  registerChatContext(db, { chat_id: 'oc_linda', bot_mode: 'ALL' });
  addMembership(db, 'felix', 'oc_felix');
  addMembership(db, 'linda', 'oc_linda');
  const own = addDraft(db, 'oc_felix', 'om_own', '星曜科技急招后端工程师，HC 2');
  const other = addDraft(db, 'oc_linda', 'om_foreign', '远航科技急招产品经理，HC 1');
  const tools = createJobFactsToolHandlers({ db });

  assert.throws(() => tools.brainx_review_job_fact({
    draft_id: other.draft_id, action: 'confirm', confirm: true,
  }, { principal: principal('felix') }), /NOT_FOUND_OR_FORBIDDEN/);
  assert.throws(() => tools.brainx_review_job_fact({
    draft_id: own.draft_id, action: 'confirm', confirm: false,
  }, { principal: principal('felix') }), /INVALID_ARGUMENT/);

  const out = tools.brainx_review_job_fact({
    draft_id: own.draft_id, action: 'confirm', confirm: true,
  }, { principal: principal('felix') });
  assert.equal(out.data.status, 'confirmed');
  assert.ok(out.data.job_ref);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts').get().n, 1);
  assert.equal(db.prepare('SELECT confirmed_by FROM job_facts_drafts WHERE draft_id=?').get(own.draft_id).confirmed_by, 'felix');
});
