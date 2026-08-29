import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { recommendationPage, RECOMMENDATION_PAGE_SIZE } from '../src/recommendation-page.js';
import { createServer } from '../src/server.js';

const CID = 'felix';
let db;

before(() => {
  db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: CID });
  recommend(db, CID, { top: RECOMMENDATION_PAGE_SIZE, persistLimit: 200 });
});

test('推荐分页固定每页20条并返回真实计数', () => {
  const page = recommendationPage(db, CID);
  assert.equal(page.items.length, RECOMMENDATION_PAGE_SIZE);
  assert.equal(page.page_size, RECOMMENDATION_PAGE_SIZE);
  assert.equal(page.total_count, db.prepare(`SELECT COUNT(*) count FROM recommendations
    WHERE run_id=?`).get(page.run_id).count);
  assert.equal(page.evaluated_count, db.prepare(`SELECT candidate_count FROM decision_runs
    WHERE run_id=?`).get(page.run_id).candidate_count);
  assert.ok(page.next_cursor);
});

test('游标翻页无重复无遗漏，末页数量正确', () => {
  const seen = [];
  let cursor = null;
  let expected = 0;
  do {
    const page = recommendationPage(db, CID, { cursor });
    expected = page.total_count;
    assert.ok(page.items.length <= RECOMMENDATION_PAGE_SIZE);
    seen.push(...page.items.map((item) => item.job.project_id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, expected);
  assert.equal(new Set(seen).size, expected);
});

test('翻页途中出现新运行仍读取原运行，并提示有新队列', () => {
  const first = recommendationPage(db, CID);
  const newer = recommend(db, CID, { top: RECOMMENDATION_PAGE_SIZE, persistLimit: 200 });
  assert.notEqual(newer.run_id, first.run_id);
  const second = recommendationPage(db, CID, { cursor: first.next_cursor });
  assert.equal(second.run_id, first.run_id);
  assert.equal(second.new_run_available, true);
  assert.ok(second.items.every((item) => item.rank > first.items.at(-1).rank));
});

test('篡改游标会明确失败，不回退到最新运行', () => {
  const result = recommendationPage(db, CID, { cursor: 'not-a-valid-cursor' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.equal(result.code, 'INVALID_RECOMMENDATION_CURSOR');
});

test('正式推荐接口返回同一分页契约', async () => {
  const previous = process.env.BRAINX_DEV_AUTH;
  process.env.BRAINX_DEV_AUTH = '1';
  const server = createServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = await fetch(`${base}/api/v1/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ consultant_id: CID }),
    });
    const cookie = session.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/v1/recommendations`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.page_size, RECOMMENDATION_PAGE_SIZE);
    assert.equal(payload.items.length, RECOMMENDATION_PAGE_SIZE);
    assert.ok(payload.next_cursor);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.BRAINX_DEV_AUTH;
    else process.env.BRAINX_DEV_AUTH = previous;
  }
});
