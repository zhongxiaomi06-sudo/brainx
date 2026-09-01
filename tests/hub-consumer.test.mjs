/** hub-consumer.test.mjs — US2 消费者崩溃后重放不产生副作用（测试先行）。
 *
 * 对应 specs/001-step0-event-ledger/spec.md US2 + SC-001/SC-003；
 * 实现为 src/hub/consumer.js 的 consumeOnce() 事务模板：
 * 业务动作与 processed_events 标记同事务提交，崩溃即整体回滚。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { consumeOnce } from '../src/hub/consumer.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-step0-')), 'test.db'));

function seedBiz(db) {
  db.exec('CREATE TABLE biz_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, marker TEXT NOT NULL)');
}
const bizCount = (db) => db.prepare('SELECT COUNT(*) n FROM biz_actions').get().n;
const markCount = (db) => db.prepare('SELECT COUNT(*) n FROM processed_events').get().n;
const doAction = (d, marker = 'done') =>
  d.prepare('INSERT INTO biz_actions (marker) VALUES (?)').run(marker);

test('US2: consumeOnce 成功后业务动作恰好一次、processed_events 有标记', () => {
  const db = newDb();
  seedBiz(db);
  const r = consumeOnce(db, 'e1', 'bridge1-push-person', doAction);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(bizCount(db), 1);
  assert.equal(markCount(db), 1);
});

test('US2: 已标记 processed 的事件再次投递直接跳过，业务动作零执行', () => {
  const db = newDb();
  seedBiz(db);
  consumeOnce(db, 'e1', 'bridge1-push-person', doAction);
  const r2 = consumeOnce(db, 'e1', 'bridge1-push-person', doAction);
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  assert.equal(bizCount(db), 1, '动作不得重复执行');
  assert.equal(markCount(db), 1);
});

test('US2: 不同消费者各自幂等（同一事件两个消费者各执行一次）', () => {
  const db = newDb();
  seedBiz(db);
  consumeOnce(db, 'e1', 'bridge1-push-person', doAction);
  consumeOnce(db, 'e1', 'bridge2-sync-talent', doAction);
  assert.equal(bizCount(db), 2);
  assert.equal(markCount(db), 2);
});

test('US2/SC-003: 中途崩溃（fn 抛错）→ 事务整体回滚，重放后与恰好一次一致', () => {
  const db = newDb();
  seedBiz(db);
  // 注入"已做一半业务动作后崩溃"：先插入再抛错，模拟标记前崩溃
  const crash = (d) => {
    doAction(d, 'half');
    throw new Error('crash-injected');
  };
  assert.throws(() => consumeOnce(db, 'e1', 'bridge1-push-person', crash), /crash-injected/);
  assert.equal(bizCount(db), 0, '崩溃后业务表必须无残留（整体回滚）');
  assert.equal(markCount(db), 0, '崩溃后不得留下 processed 标记');
  // 重放：同一事件以正常 fn 重投，最终状态与"恰好一次"一致
  const r = consumeOnce(db, 'e1', 'bridge1-push-person', doAction);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.equal(bizCount(db), 1);
  assert.equal(markCount(db), 1);
});
