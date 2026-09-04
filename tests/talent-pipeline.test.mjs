import assert from 'node:assert/strict';
import test from 'node:test';

import { runCursorSync } from '../src/talent-pipeline/sync-cursor.js';
import { mysqlLocalDatetime } from '../src/db.js';

test('383 structured profiles are fetched in bounded pages and cursor advances once', async () => {
  const source = Array.from({ length: 383 }, (_, index) => ({ id: index + 1 }));
  const written = [];
  const saved = [];
  const result = await runCursorSync({
    initialCursor: null,
    pageSize: 100,
    fetchPage: async ({ cursor, limit }) => {
      const offset = cursor ? Number(cursor) : 0;
      const items = source.slice(offset, offset + limit);
      const nextCursor = String(offset + items.length);
      return { items, nextCursor, hasMore: offset + items.length < source.length };
    },
    writePage: async items => written.push(...items),
    saveCursor: async cursor => saved.push(cursor),
  });
  assert.equal(result.items_processed, 383);
  assert.equal(result.pages_processed, 4);
  assert.equal(result.final_cursor, '383');
  assert.equal(new Set(written.map(item => item.id)).size, 383);
  assert.deepEqual(saved, ['383']);
});

test('cursor never advances when any page fails and replay remains idempotent', async () => {
  const writes = new Set();
  const saved = [];
  const fetchPage = async ({ cursor }) => {
    if (cursor === '2') throw new Error('source unavailable');
    return { items: [{ id: 1 }, { id: 2 }], nextCursor: '2', hasMore: true };
  };
  await assert.rejects(() => runCursorSync({
    initialCursor: null, pageSize: 2, fetchPage,
    writePage: async items => items.forEach(item => writes.add(item.id)),
    saveCursor: async cursor => saved.push(cursor),
  }), /source unavailable/);
  assert.deepEqual([...writes], [1, 2]);
  assert.deepEqual(saved, []);
});

test('invalid and non-progressing source pages fail closed', async () => {
  await assert.rejects(() => runCursorSync({
    fetchPage: async () => ({ items: [], nextCursor: null, hasMore: true }),
    writePage: async () => {}, saveCursor: async () => {},
  }), /SOURCE_PAGE_INVALID/);
  await assert.rejects(() => runCursorSync({
    initialCursor: 'same', fetchPage: async () => ({ items: [{}], nextCursor: 'same', hasMore: true }),
    writePage: async () => {}, saveCursor: async () => {},
  }), /SOURCE_CURSOR_STALLED/);
});

test('mysqlLocalDatetime keeps the MySQL wall-clock instead of shifting to UTC', () => {
  // mysql2 把 DATETIME 解析成本地时区 Date。用本地构造器构造，断言与时区无关
  // （本地字段由构造参数固定）：2026-08-29 04:46:38 本地墙钟必须原样往返。
  const local = new Date(2026, 7, 29, 4, 46, 38);
  assert.equal(mysqlLocalDatetime(local), '2026-08-29 04:46:38');
  // 曾导致游标停滞的写法：toISOString 把 +08:00 墙钟转成 UTC 时刻（早 8 小时）。
  assert.notEqual(local.toISOString(), '2026-08-29T04:46:38.000Z');
});
