import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { localToUtcIso, mapLarkCliMessage, parseLarkCliOutput, backfillRows } from '../src/lark-backfill.js';

const SCHEMA = `CREATE TABLE lark_messages (
  message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_type TEXT, text TEXT,
  mentions_json TEXT, create_time TEXT NOT NULL, received_at TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'gateway')`;

test('localToUtcIso: 飞书分钟精度本地时间转 UTC ISO', () => {
  // 2026-07-29 18:47 +08:00 == 2026-07-29T10:47Z
  assert.equal(localToUtcIso('2026-07-29 18:47'), '2026-07-29T10:47:00.000Z');
  assert.equal(localToUtcIso('2026-07-29 18:47:33'), '2026-07-29T10:47:33.000Z');
});

test('localToUtcIso: 非法输入返回 null', () => {
  assert.equal(localToUtcIso(null), null);
  assert.equal(localToUtcIso('not-a-date'), null);
  assert.equal(localToUtcIso(12345), null);
});

test('mapLarkCliMessage: 正常条目完整映射', () => {
  const row = mapLarkCliMessage({
    message_id: 'om_abc', chat_id: 'oc_x', msg_type: 'text',
    content: '招后端', create_time: '2026-07-29 18:47',
    mentions: [{ id: 'ou_1' }, { id: 'ou_2' }, { broken: true }],
  });
  assert.equal(row.message_id, 'om_abc');
  assert.equal(row.message_type, 'text');
  assert.equal(row.text, '招后端');
  assert.equal(row.mentions_json, JSON.stringify(['ou_1', 'ou_2']));
  assert.equal(row.create_time, '2026-07-29T10:47:00.000Z');
  assert.ok(row.received_at);
});

test('mapLarkCliMessage: 非法/已撤回条目返回 null', () => {
  assert.equal(mapLarkCliMessage(null), null);
  assert.equal(mapLarkCliMessage({ message_id: 'om_x', chat_id: 'oc', create_time: 'bad' }), null);
  assert.equal(mapLarkCliMessage({ message_id: 'om_x', chat_id: 'oc', create_time: '2026-07-29 18:47', deleted: true }), null);
  assert.equal(mapLarkCliMessage({ message_id: 'bad-prefix', chat_id: 'oc', create_time: '2026-07-29 18:47' }), null);
});

test('parseLarkCliOutput: 解析 lark-cli 输出并校验结构', () => {
  const ok = JSON.stringify({ ok: true, data: { messages: [{ message_id: 'om_1' }] } });
  assert.equal(parseLarkCliOutput(ok).length, 1);
  assert.throws(() => parseLarkCliOutput(JSON.stringify({ ok: false })), /未成功/);
  assert.throws(() => parseLarkCliOutput(JSON.stringify({ ok: true, data: {} })), /messages/);
  assert.throws(() => parseLarkCliOutput('no json here'), /JSON/);
});

test('backfillRows: 幂等——重复插入不增行', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const rows = [mapLarkCliMessage({
    message_id: 'om_1', chat_id: 'oc_x', msg_type: 'text',
    content: 'a', create_time: '2026-07-29 18:47',
  })];
  const first = backfillRows(db, rows);
  assert.deepEqual(first, { total: 1, inserted: 1 });
  const second = backfillRows(db, rows);
  assert.deepEqual(second, { total: 1, inserted: 0 });
});
