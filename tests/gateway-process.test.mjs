/** gateway-process.test.mjs — processLarkEvent 6 场景 fixtures 回放（测试先行）。
 *
 * 对应 specs/002-step1-lark-gateway/spec.md US1-US4 + SC-001~SC-004；
 * 实现为 src/gateway/lark-gateway.js 的 processLarkEvent() + envelope-mapper.js。
 * 机器人身份约定：open_id = "ou_bot"（mentions 含此即视为 @机器人）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { registerChatContext, setChatEnabled } from '../src/gateway/chat-contexts.js';
import { processLarkEvent, BOT_OPEN_ID } from '../src/gateway/lark-gateway.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures/step1', name), 'utf8'));
const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step1-')), 'test.db'));
const events = (db, type) =>
  db.prepare('SELECT * FROM workflow_event_log WHERE event_type = ?').all(type);
const ledgerCount = (db) => db.prepare('SELECT COUNT(*) n FROM workflow_event_log').get().n;

function seedRegistered(db) {
  registerChatContext(db, { chat_id: 'oc_registered', bot_mode: 'MENTION_ONLY' });
  registerChatContext(db, { chat_id: 'oc_disabled', bot_mode: 'MENTION_ONLY' });
  setChatEnabled(db, 'oc_disabled', false);
}

test('US1: 已登记群 @机器人消息落 lark.message_received，返回 queued', () => {
  const db = newDb();
  seedRegistered(db);
  const r = processLarkEvent(db, loadFixture('message-mention-bot.json'));
  assert.equal(r.ack, true);
  assert.equal(r.action, 'queued');
  const evts = events(db, 'lark.message_received');
  assert.equal(evts.length, 1);
  const e = evts[0];
  assert.equal(e.idem_key, 'lark:message:om_mention_1');
  assert.equal(e.actor, 'user:ou_user_1');
  assert.equal(e.case_id, null);
  const refs = JSON.parse(e.evidence_refs);
  assert.deepEqual(refs, [
    { table: 'chat_contexts', id: 'oc_registered' },
    { table: 'lark_messages', id: 'om_mention_1' },
  ]);
  const payload = JSON.parse(e.payload);
  assert.equal(payload.bot_mode, 'MENTION_ONLY');
  assert.equal(payload.message_type, 'text');
  assert.ok(!payload.content, 'payload 不得含消息正文 PII');
});

test('US2: 未登记群默认 DENY，落 lark.ignored（unregistered_chat），不进 inbox', () => {
  const db = newDb();
  seedRegistered(db);
  const r = processLarkEvent(db, loadFixture('message-unregistered-chat.json'));
  assert.equal(r.ack, true);
  assert.equal(r.action, 'denied');
  assert.equal(r.reason, 'unregistered_chat');
  assert.equal(events(db, 'lark.message_received').length, 0, '不得进 inbox');
  const ignored = events(db, 'lark.ignored');
  assert.equal(ignored.length, 1);
  assert.equal(JSON.parse(ignored[0].payload).reason, 'unregistered_chat');
});

test('US2: 已登记但 enabled=false 同样 DENY（chat_disabled）', () => {
  const db = newDb();
  seedRegistered(db);
  const r = processLarkEvent(db, loadFixture('message-disabled-chat.json'));
  assert.equal(r.action, 'denied');
  assert.equal(r.reason, 'chat_disabled');
  assert.equal(events(db, 'lark.message_received').length, 0);
  assert.equal(events(db, 'lark.ignored').length, 1);
});

test('US3: 已登记群非 @ 消息 DENY（not_mentioned），不进 inbox', () => {
  const db = newDb();
  seedRegistered(db);
  const r = processLarkEvent(db, loadFixture('message-not-mentioned.json'));
  assert.equal(r.action, 'denied');
  assert.equal(r.reason, 'not_mentioned');
  assert.equal(events(db, 'lark.message_received').length, 0);
  assert.equal(events(db, 'lark.ignored').length, 1);
});

test('US4: 重复 message_id 投递账本恒 1 行，第二次返回 duplicate', () => {
  const db = newDb();
  seedRegistered(db);
  const evt = loadFixture('message-mention-bot.json');
  const a = processLarkEvent(db, evt);
  const b = processLarkEvent(db, evt);
  assert.equal(a.action, 'queued');
  assert.equal(b.action, 'duplicate');
  assert.equal(b.ack, true);
  assert.equal(events(db, 'lark.message_received').length, 1, '账本恒 1 行');
  assert.equal(events(db, 'lark.ignored').length, 0);
});

test('边界: 无 message_id 非法事件拒绝不落账（malformed_event）', () => {
  const db = newDb();
  seedRegistered(db);
  const r = processLarkEvent(db, loadFixture('message-malformed.json'));
  assert.equal(r.ack, false);
  assert.equal(r.reason, 'malformed_event');
  assert.equal(ledgerCount(db), 0, '不得落任何事件');
});

test('边界: 无 chat_scope（chat_id 空）DENY（no_chat_scope）', () => {
  const db = newDb();
  seedRegistered(db);
  const r = processLarkEvent(db, loadFixture('message-no-chat-scope.json'));
  assert.equal(r.action, 'denied');
  assert.equal(r.reason, 'no_chat_scope');
  assert.equal(events(db, 'lark.message_received').length, 0);
  assert.equal(events(db, 'lark.ignored').length, 1);
});

test('SC-002: 同一 message_id 既 DENY 又在登记后重投通过，两类事件各自幂等不被吃掉', () => {
  const db = newDb();
  // 未登记时投递 → lark.ignored
  processLarkEvent(db, loadFixture('message-unregistered-chat.json'));
  // 现在登记该群，重投同 message_id → 应通过（DENY 的 idem_key 与通过不同）
  registerChatContext(db, { chat_id: 'oc_unregistered', bot_mode: 'MENTION_ONLY' });
  // 但 mentions 含 ou_bot，通过
  const r = processLarkEvent(db, loadFixture('message-unregistered-chat.json'));
  assert.equal(r.action, 'queued');
  assert.equal(events(db, 'lark.ignored').length, 1, 'DENY 留痕不被吃掉');
  assert.equal(events(db, 'lark.message_received').length, 1, '通过事件独立落账');
});

test('修复 BOT_OPEN_ID 占位符：注入真实 botOpenId 后 @机器人 正确判定', () => {
  const db = newDb();
  seedRegistered(db);
  // 真实机器人 open_id 是 ou_xxxx，永远不等于占位 'ou_bot'
  const realBot = 'ou_7f3c9a1e真实机器人';
  const evt = {
    message_id: 'om_real_bot',
    chat_id: 'oc_registered',
    open_id: 'ou_user_1',
    mentions: [realBot], // @的是真实机器人
    message_type: 'text',
    create_time: '2026-09-02T11:00:00Z',
    body: {},
  };
  // 不注入 botOpenId（用占位默认）→ 误判 not_mentioned（缺陷复现）
  const buggy = processLarkEvent(db, evt);
  assert.equal(buggy.action, 'denied');
  assert.equal(buggy.reason, 'not_mentioned', '占位常量下真实 @机器人 被误判（缺陷复现）');
  // 注入真实 botOpenId → 正确通过
  const fixed = processLarkEvent(db, { ...evt, message_id: 'om_real_bot_2' }, realBot);
  assert.equal(fixed.action, 'queued', '注入真实 botOpenId 后 @机器人 正确落账');
  assert.equal(events(db, 'lark.message_received').length, 1);
});
