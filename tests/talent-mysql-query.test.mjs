import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTalentListQuery } from '../src/talent-mysql-query.js';

test('MySQL 人才分页把已校验整数内联，避免 LIMIT prepared statement 不兼容', () => {
  const plain = buildTalentListQuery({ limit: 20, offset: 40, status: null });
  assert.match(plain.sql, /LIMIT 20 OFFSET 40$/);
  assert.doesNotMatch(plain.sql, /LIMIT \?|OFFSET \?/);
  assert.deepEqual(plain.args, []);

  const filtered = buildTalentListQuery({ limit: '999', offset: '-2', status: 'active' });
  assert.match(filtered.sql, /WHERE status=\?.*LIMIT 100 OFFSET 0$/);
  assert.deepEqual(filtered.args, ['active']);
});
