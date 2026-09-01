/** hub-upcaster.test.mjs — 旧结构事件经 upcaster 逐级转换，不可转换者落 DLQ（测试先行）。
 *
 * 对应 specs/001-step0-event-ledger/spec.md FR-007 与边界用例；
 * 实现为 src/hub/upcaster.js。当前 CURRENT_SCHEMA_VERSION=1，无内建 upcaster；
 * 未来结构演进通过 registerUpcast(fromVersion, fn) 注册 N→N+1 转换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { upcastEvent, upcastTo, registerUpcast, CURRENT_SCHEMA_VERSION } from '../src/hub/upcaster.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db'));
const dlqCount = (db) => db.prepare('SELECT COUNT(*) n FROM event_dlq').get().n;
const V1 = { event_id: 'e-v1', schema_version: 1, payload: { run_id: 'run-1' } };

test('T015: 当前版本事件直通，不落 DLQ', () => {
  const db = newDb();
  const r = upcastEvent(db, V1);
  assert.equal(r.ok, true);
  assert.equal(r.event.schema_version, CURRENT_SCHEMA_VERSION);
  assert.equal(dlqCount(db), 0);
});

test('T015: 旧版本事件经注册的 upcaster 逐级转换（1→2→3，upcastTo 指定目标）', () => {
  const db = newDb();
  registerUpcast(1, (e) => ({ ...e, schema_version: 2, payload: { ...e.payload, v2: true } }));
  registerUpcast(2, (e) => ({ ...e, schema_version: 3, payload: { ...e.payload, v3: true } }));
  const r = upcastTo(db, V1, 3);
  assert.equal(r.ok, true);
  assert.equal(r.event.schema_version, 3);
  assert.equal(r.event.payload.v2, true);
  assert.equal(r.event.payload.v3, true);
  assert.equal(dlqCount(db), 0);
});

test('T015: 转换链上缺口（缺少注册 upcaster）落 event_dlq（reason=upcast_failed）', () => {
  const db = newDb();
  // 注册表跨用例共享：用高位版本号 101→103 构造无碰撞缺口（101 无注册项）
  registerUpcast(102, (e) => ({ ...e, schema_version: 103 }));
  const r = upcastTo(db, { ...V1, event_id: 'e-noup', schema_version: 101 }, 103);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upcast_failed');
  const row = db.prepare('SELECT * FROM event_dlq WHERE event_id = ?').get('e-noup');
  assert.ok(row, '必须落 DLQ 等价表');
  assert.equal(row.reason, 'upcast_failed');
  assert.deepEqual(JSON.parse(row.raw_payload).payload, { run_id: 'run-1' }, '原始负载必须完整保留');
});

test('T015: 比当前更新（未知未来结构）的事件不可消费，落 DLQ（schema_invalid）', () => {
  const db = newDb();
  const r = upcastEvent(db, { ...V1, event_id: 'e-v9', schema_version: 9 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'schema_invalid');
  const row = db.prepare('SELECT * FROM event_dlq WHERE event_id = ?').get('e-v9');
  assert.ok(row, '必须落 DLQ 等价表');
  assert.deepEqual(JSON.parse(row.raw_payload).payload, { run_id: 'run-1' });
});

test('T015: upcaster 执行抛错同样落 DLQ 且不向上抛异常', () => {
  const db = newDb();
  registerUpcast(1, () => {
    throw new Error('bad-upcaster');
  });
  const r = upcastTo(db, { ...V1, event_id: 'e-bad' }, 2);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'upcast_failed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM event_dlq WHERE event_id = ?').get('e-bad').n, 1);
});
