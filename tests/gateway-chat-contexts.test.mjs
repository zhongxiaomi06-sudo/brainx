/** gateway-chat-contexts.test.mjs — chat_contexts 注册工具（测试先行）。
 *
 * 对应 specs/002-step1-lark-gateway/spec.md FR-005；
 * 实现为 src/gateway/chat-contexts.js 的 register/get/setEnabled/list。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  registerChatContext,
  setChatEnabled,
  getChatContext,
  listChatContexts,
} from '../src/gateway/chat-contexts.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step1-')), 'test.db'));

test('FR-005: registerChatContext 写入并查询', () => {
  const db = newDb();
  const r = registerChatContext(db, { chat_id: 'oc_1', bot_mode: 'MENTION_ONLY', notes: 'demo' });
  assert.equal(r.ok, true);
  const c = getChatContext(db, 'oc_1');
  assert.equal(c.chat_id, 'oc_1');
  assert.equal(c.enabled, 1);
  assert.equal(c.bot_mode, 'MENTION_ONLY');
  assert.equal(c.notes, 'demo');
});

test('FR-005: 默认 bot_mode=MENTION_ONLY，未登记群 getChatContext 返回 null', () => {
  const db = newDb();
  assert.equal(getChatContext(db, 'oc_ghost'), null);
  const r = registerChatContext(db, { chat_id: 'oc_2' });
  assert.equal(r.ok, true);
  assert.equal(getChatContext(db, 'oc_2').bot_mode, 'MENTION_ONLY');
});

test('FR-005: 重复 chat_id upsert 刷新 bot_mode/notes，不改 enabled', () => {
  const db = newDb();
  registerChatContext(db, { chat_id: 'oc_3', bot_mode: 'MENTION_ONLY', notes: 'v1' });
  setChatEnabled(db, 'oc_3', false);
  assert.equal(getChatContext(db, 'oc_3').enabled, 0);
  registerChatContext(db, { chat_id: 'oc_3', bot_mode: 'ALL', notes: 'v2' });
  const c = getChatContext(db, 'oc_3');
  assert.equal(c.bot_mode, 'ALL');
  assert.equal(c.notes, 'v2');
  assert.equal(c.enabled, 0, 'upsert 不得重置 enabled');
});

test('FR-005: setChatEnabled 启停', () => {
  const db = newDb();
  registerChatContext(db, { chat_id: 'oc_4' });
  assert.equal(getChatContext(db, 'oc_4').enabled, 1);
  setChatEnabled(db, 'oc_4', false);
  assert.equal(getChatContext(db, 'oc_4').enabled, 0);
  setChatEnabled(db, 'oc_4', true);
  assert.equal(getChatContext(db, 'oc_4').enabled, 1);
});

test('FR-005: setChatEnabled 对未登记群返回 not_found', () => {
  const db = newDb();
  const r = setChatEnabled(db, 'oc_ghost', false);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

test('FR-005: listChatContexts 列举全部', () => {
  const db = newDb();
  registerChatContext(db, { chat_id: 'oc_a' });
  registerChatContext(db, { chat_id: 'oc_b', bot_mode: 'ALL' });
  const all = listChatContexts(db);
  assert.equal(all.length, 2);
  assert.ok(all.some((c) => c.chat_id === 'oc_a'));
  assert.ok(all.some((c) => c.chat_id === 'oc_b' && c.bot_mode === 'ALL'));
});
