/** hub-entity-links.test.mjs — US4 身份跨系统可解析（测试先行）。
 *
 * 对应 specs/001-step0-event-ledger/spec.md US4 + SC-001；
 * 实现为 src/hub/entity-links.js 的 linkEntities() / resolveEntity()。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { linkEntities, resolveEntity } from '../src/hub/entity-links.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db'));

function seedCase(db, caseId) {
  db.prepare(
    'INSERT INTO cases (case_id, position_id, candidate_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(caseId, `pos-${caseId}`, `cand-${caseId}`, '2026-09-02T02:00:00Z', '2026-09-02T02:00:00Z');
}

const LINK = {
  case_id: 'c1',
  brainx_id: 'brainx-1',
  talent_pool_id: 'tp-1',
  reloop_id: 'reloop-1',
  lark_open_id: 'ou-1',
};

test('US4: 写入链接后按任一侧 ID 查询得到全链', () => {
  const db = newDb();
  seedCase(db, 'c1');
  const r = linkEntities(db, LINK);
  assert.equal(r.ok, true);
  for (const key of ['brainx_id', 'talent_pool_id', 'reloop_id', 'lark_open_id']) {
    const found = resolveEntity(db, LINK[key]);
    assert.ok(found, `按 ${key} 应能解析`);
    assert.equal(found.case_id, 'c1');
    assert.equal(found.reloop_id, 'reloop-1');
    assert.equal(found.lark_open_id, 'ou-1');
  }
  // case_id 本身也是解析入口
  assert.equal(resolveEntity(db, 'c1').brainx_id, 'brainx-1');
});

test('US4: 未知 ID 解析返回 null 而非抛错', () => {
  const db = newDb();
  assert.equal(resolveEntity(db, 'ghost-id'), null);
});

test('US4: 同一外键重复链接到新实体被拒绝', () => {
  const db = newDb();
  seedCase(db, 'c1');
  seedCase(db, 'c2');
  assert.equal(linkEntities(db, LINK).ok, true);
  const r = linkEntities(db, { ...LINK, case_id: 'c2' }); // lark_open_id 等已被 c1 占用
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'already_linked');
  assert.equal(resolveEntity(db, 'ou-1').case_id, 'c1', '原链接不受影响');
});

test('US4: 对不存在的 case 链接被外键拒绝', () => {
  const db = newDb();
  const r = linkEntities(db, { ...LINK, case_id: 'ghost-case' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'case_not_found');
});
