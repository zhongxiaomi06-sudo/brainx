/** hub-case-machine.test.mjs — US3 Case 双轴状态机只按合法路径推进（测试先行）。
 *
 * 对应 specs/001-step0-event-ledger/spec.md US3 + SC-001；
 * 实现为 src/hub/case-machine.js 的 advanceCase() 乐观锁推进：
 * 非法跳跃拒绝并落 case.transition_rejected 事件；version 冲突显式失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { advanceCase, MILESTONE_PATH } from '../src/hub/case-machine.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db'));

function seedCase(db, caseId = 'c1') {
  db.prepare(
    'INSERT INTO cases (case_id, position_id, candidate_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(caseId, 'pos-1', 'cand-ref-1', '2026-09-02T02:00:00Z', '2026-09-02T02:00:00Z');
}
const getCase = (db, caseId = 'c1') => db.prepare('SELECT * FROM cases WHERE case_id = ?').get(caseId);
const eventsOfType = (db, type) =>
  db.prepare('SELECT * FROM workflow_event_log WHERE event_type = ?').all(type);

test('US3: 合法相邻推进成功——状态更新、版本+1、账本落 case.stage_advanced', () => {
  const db = newDb();
  seedCase(db);
  const r = advanceCase(db, 'c1', 'QUALIFIED');
  assert.equal(r.ok, true);
  const c = getCase(db);
  assert.equal(c.milestone, 'QUALIFIED');
  assert.equal(c.version, 2);
  const evts = eventsOfType(db, 'case.stage_advanced');
  assert.equal(evts.length, 1);
  assert.equal(evts[0].case_id, 'c1');
  assert.deepEqual(JSON.parse(evts[0].payload), { from: 'DISCOVERED', to: 'QUALIFIED' });
});

test('US3: 全链合法路径可一路推进到 PLACED（每步版本+1）', () => {
  const db = newDb();
  seedCase(db);
  for (let i = 1; i < MILESTONE_PATH.length; i++) {
    const r = advanceCase(db, 'c1', MILESTONE_PATH[i]);
    assert.equal(r.ok, true, `${MILESTONE_PATH[i - 1]}→${MILESTONE_PATH[i]} 应合法`);
  }
  assert.equal(getCase(db).milestone, 'PLACED');
  assert.equal(getCase(db).version, MILESTONE_PATH.length);
  assert.equal(eventsOfType(db, 'case.stage_advanced').length, MILESTONE_PATH.length - 1);
});

test('US3: 非法跳跃被拒绝且账本落 case.transition_rejected', () => {
  const db = newDb();
  seedCase(db);
  const r = advanceCase(db, 'c1', 'OFFER'); // DISCOVERED→OFFER 非法
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'illegal_transition');
  assert.equal(getCase(db).milestone, 'DISCOVERED', '状态不得被非法迁移改动');
  const rej = eventsOfType(db, 'case.transition_rejected');
  assert.equal(rej.length, 1, '拒绝必须留痕');
  assert.deepEqual(JSON.parse(rej[0].payload), { from: 'DISCOVERED', to: 'OFFER' });
});

test('US3: 未知 Case 返回 case_not_found', () => {
  const db = newDb();
  const r = advanceCase(db, 'ghost', 'QUALIFIED');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'case_not_found');
});

test('US3: 持陈旧快照的并发推进显式失败（version 乐观锁冲突）', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db');
  const dbA = openDb(path);
  seedCase(dbA);
  const dbB = openDb(path);
  // 模拟真并发：B 先读到 v1 快照，随后 A 完成推进；B 再以快照提交
  const staleRow = getCase(dbB);
  const rA = advanceCase(dbA, 'c1', 'QUALIFIED');
  const rB = advanceCase(dbB, 'c1', 'QUALIFIED', { caseRow: staleRow });
  assert.equal(rA.ok, true, 'A 持最新状态应成功');
  assert.equal(rB.ok, false, 'B 持陈旧快照必须显式失败，不得静默');
  assert.equal(rB.reason, 'version_conflict');
  const c = getCase(dbA);
  assert.equal(c.milestone, 'QUALIFIED');
  assert.equal(c.version, 2);
  assert.equal(eventsOfType(dbA, 'case.stage_advanced').length, 1, '账本只记一次成功推进');
});
