/** hub-event-log.test.mjs — US1 事件只落账一次（fixtures 回放，测试先行）。
 *
 * 对应 specs/001-step0-event-ledger/spec.md US1 + SC-001/SC-002；
 * 实现为 src/hub/envelope.js（信封校验）与 src/hub/event-log.js（appendEvent）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { appendEvent } from '../src/hub/event-log.js';

const here = dirname(fileURLToPath(import.meta.url));
const loadFixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures/step0', name), 'utf8'));
const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db'));
const ledgerCount = (db) => db.prepare('SELECT COUNT(*) n FROM workflow_event_log').get().n;

test('US1: 同一 idem_key 重复投递，账本仅一行且返回值一致', () => {
  const db = newDb();
  const evt = loadFixture('event-sample.json');
  const first = appendEvent(db, evt);
  assert.equal(first.ok, true, '首次写入应成功');
  assert.equal(first.deduplicated, false);
  const second = appendEvent(db, evt);
  assert.equal(second.ok, true, '重复投递应幂等成功而非抛错');
  assert.equal(second.deduplicated, true);
  assert.equal(second.event.event_id, first.event.event_id, '应返回既有行');
  assert.equal(ledgerCount(db), 1);
});

test('US1/SC-002: 重复投递 1000 次，账本行数恒为 1', () => {
  const db = newDb();
  const evt = loadFixture('event-sample.json');
  let seenEventId = null;
  for (let i = 0; i < 1000; i++) {
    const r = appendEvent(db, evt);
    assert.equal(r.ok, true);
    if (seenEventId === null) seenEventId = r.event.event_id;
    assert.equal(r.event.event_id, seenEventId);
  }
  assert.equal(ledgerCount(db), 1);
});

test('US1: 并发双连接写相同 idem_key，仅一行（idx_wel_idem 兜底）', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db');
  const dbA = openDb(path);
  const dbB = openDb(path);
  const evt = loadFixture('event-sample.json');
  const [ra, rb] = await Promise.all([
    Promise.resolve().then(() => appendEvent(dbA, evt)),
    Promise.resolve().then(() => appendEvent(dbB, evt)),
  ]);
  assert.equal(ra.ok && rb.ok, true, '双方都应成功（一方读到既有行）');
  const results = [ra, rb].sort((x) => (x.deduplicated ? 1 : -1));
  assert.equal(results[0].deduplicated, false, '恰有一方真实写入');
  assert.equal(results[1].deduplicated, true, '另一方读到既有行');
  assert.equal(ledgerCount(dbA), 1);
});

test('US1/FR-005: 信封缺字段（缺 actor）被拒绝，不入库', () => {
  const db = newDb();
  const r = appendEvent(db, loadFixture('invalid-envelope.json'));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'schema_invalid');
  assert.ok(r.errors.length > 0, '应携带校验错误说明');
  assert.equal(ledgerCount(db), 0);
});

test('US1 边界: payload 超过 64KB 拒绝入库（账本存引用不存大对象）', () => {
  const db = newDb();
  const evt = loadFixture('event-sample.json');
  evt.payload = { blob: 'x'.repeat(70 * 1024) };
  const r = appendEvent(db, evt);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'payload_too_large');
  assert.equal(ledgerCount(db), 0);
});
