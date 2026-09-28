/** profile-init.test.mjs — 画像首初始化：证据汇总 / 提案解析 / 覆盖率评估 / 写库守门。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  gatherProfileEvidence, buildProfilePrompt, parseProfileProposal, evaluateProposal,
} from '../src/profile-init.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-pi-')), 't.db'));

function seed(db) {
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO consultants (consultant_id, display_name, open_id, active, created_at)
    VALUES ('tester', 'Test 测试', 'ou_t', 1, ?) ON CONFLICT(consultant_id) DO NOTHING`).run(ts);
  db.prepare('INSERT INTO consultant_chats (consultant_id, chat_id, seen_at) VALUES (?,?,?)')
    .run('tester', 'oc_t1', ts);
  const jobs = [
    ['pj_t1', '星海科技', '海外增长负责人'],
    ['pj_t2', '云图智能', '增长产品经理'],
    ['pj_t3', '北辰生物', '供应链总监'],
  ];
  for (const [pid, company, role] of jobs) {
    db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
      VALUES (?, 'tester', 'fixture', ?, 'h', ?)`).run(`sr_${pid}`, ts, ts);
    db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at, chat_id)
      VALUES (?, ?, ?, ?, ?, '{}', ?, 'oc_t1')`).run(pid, company, role, ts, `sr_${pid}`, ts);
  }
  db.prepare(`INSERT INTO lark_messages (message_id, chat_id, message_type, text, create_time, received_at)
    VALUES ('om_t1', 'oc_t1', 'text', '增长岗位的候选人有进展吗', ?, ?)`).run(ts, ts);
}

test('证据汇总：群关联职位聚合公司/职位频次，策展职位加权', () => {
  const db = newDb();
  seed(db);
  const ev = gatherProfileEvidence(db, 'tester');
  assert.equal(ev.chat_count, 1);
  assert.equal(ev.job_count, 3);
  assert.ok(ev.top_companies.length >= 3);
  assert.equal(ev.sample_messages.length, 1);
});

test('提案解析：合法 JSON 通过；坏 JSON/空关键词/超长一律拒绝（宁缺勿错）', () => {
  const ok = parseProfileProposal('{"keywords":["海外增长","AI产品"],"note":"做增长"}');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.profile_keywords, ['海外增长', 'AI产品']);
  assert.equal(parseProfileProposal('not json').ok, false);
  assert.equal(parseProfileProposal('{"keywords":[]}').ok, false);
  assert.equal(parseProfileProposal('{"keywords":["x"]}').ok, false, '单字关键词拒绝');
  const tooMany = JSON.stringify({ keywords: Array.from({ length: 25 }, (_, i) => `词${i}`) });
  assert.equal(parseProfileProposal(tooMany).ok, false, '超 20 个关键词拒绝');
});

test('覆盖率评估：提案关键词命中群关联职位比例', () => {
  const db = newDb();
  seed(db);
  const good = evaluateProposal(db, 'tester', ['增长', '星海']);
  assert.equal(good.hit, 2); // pj_t1(公司+职位双中)、pj_t2(职位中)
  assert.equal(good.total, 3);
  const bad = evaluateProposal(db, 'tester', ['区块链']);
  assert.equal(bad.hit, 0);
  const empty = evaluateProposal(db, 'tester', []);
  assert.equal(empty.coverage, 0);
});

test('prompt 构建包含证据且要求 JSON 输出', () => {
  const db = newDb();
  seed(db);
  const { system, user } = buildProfilePrompt(gatherProfileEvidence(db, 'tester'));
  assert.match(system, /只输出 JSON/);
  assert.match(system, /证据不足/);
  assert.match(user, /星海科技/);
});
