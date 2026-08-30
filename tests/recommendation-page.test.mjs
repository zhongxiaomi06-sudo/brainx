import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { recommendationPage, RECOMMENDATION_PAGE_SIZE } from '../src/recommendation-page.js';
import { dataConfidenceOf, recommendationPresentationOf } from '../src/recommendation-presentation.js';
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
  assert.ok(page.items.every((item) => ['TODAY', 'WEEK', 'VERIFY'].includes(item.decision_tier)));
  assert.ok(page.items.every((item) => ['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT'].includes(item.data_confidence.band)));
  assert.ok(page.items.every((item) => item.data_confidence.rule_version === 'data-confidence-1.0'));
  assert.ok(page.items.every((item) => item.presentation_source === 'FROZEN'));
  assert.ok(page.next_cursor);
});

test('推荐展示只用真实关键事实、更新时间和活动生成层级', () => {
  const job = {
    active_state: 'OPEN', hc: 2, current_stage: '寻访', next_action: '联系客户确认面试窗口',
    captured_at: '2026-08-29T08:00:00+08:00', chat_last_at: '2026-08-30 09:00', chat_msgs_7d: 4,
    fact_updated_at: {},
  };
  const confidence = dataConfidenceOf(job, 'MY_JOB', '2026-08-30T10:00:00+08:00');
  const presentation = recommendationPresentationOf(job, 'MY_JOB', 'RECOMMEND_ACCEPT',
    '2026-08-30T10:00:00+08:00', confidence);
  assert.equal(confidence.band, 'SUFFICIENT');
  assert.deepEqual(confidence.missing_fields, []);
  assert.equal(presentation.decision_tier, 'TODAY');
  assert.equal(presentation.decision_tier_reason.code, 'EXPLICIT_NEXT_ACTION');
  assert.equal(presentation.recent_activity.type, 'CHAT_ACTIVITY');
  assert.equal(presentation.recent_activity.detail, '近7天 4 条消息');
});

test('关键事实多项缺失或过期时必须降级为待核验', () => {
  const job = {
    active_state: 'OPEN', hc: null, current_stage: null, next_action: '直接推进',
    captured_at: '2026-07-01T08:00:00+08:00', fact_updated_at: {},
  };
  const confidence = dataConfidenceOf(job, 'TEAM_SHARED', '2026-08-30T10:00:00+08:00');
  const presentation = recommendationPresentationOf(job, 'TEAM_SHARED', 'RECOMMEND_ACCEPT',
    '2026-08-30T10:00:00+08:00', confidence);
  assert.equal(confidence.band, 'INSUFFICIENT');
  assert.deepEqual(confidence.missing_fields, ['HC', '当前阶段']);
  assert.equal(confidence.stale, true);
  assert.match(confidence.primary_risk, /超过有效窗口/);
  assert.equal(presentation.decision_tier, 'VERIFY');
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

test('完整冻结队列支持推荐优先级、最近活动和事实可信度稳定排序', () => {
  const collect = (sort) => {
    const items = [];
    let cursor = null;
    do {
      const page = recommendationPage(db, CID, { cursor, sort });
      assert.equal(page.sort, sort);
      items.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    assert.equal(new Set(items.map((item) => item.job.project_id)).size, items.length);
    return items;
  };
  const priority = collect('priority');
  assert.deepEqual(priority.map((item) => item.rank), priority.map((item) => item.rank).sort((a, b) => a - b));

  const recent = collect('recent');
  const recentKeys = recent.map((item) => item.recent_activity?.occurred_at || null);
  assert.deepEqual(recentKeys, recentKeys.slice().sort((left, right) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return right.localeCompare(left);
  }));

  const confidence = collect('confidence');
  const bands = { SUFFICIENT: 0, PARTIAL: 1, INSUFFICIENT: 2 };
  const confidenceKeys = confidence.map((item) => bands[item.data_confidence.band]);
  assert.deepEqual(confidenceKeys, confidenceKeys.slice().sort((a, b) => a - b));
});

test('排序方式绑定分页游标，变化后必须从第一页重新排序', () => {
  const first = recommendationPage(db, CID, { sort: 'recent' });
  assert.ok(first.next_cursor);
  const mismatch = recommendationPage(db, CID, { cursor: first.next_cursor, sort: 'confidence' });
  assert.equal(mismatch.code, 'INVALID_RECOMMENDATION_CURSOR');
  assert.equal(recommendationPage(db, CID, { sort: 'unknown' }).code, 'INVALID_RECOMMENDATION_SORT');
});

test('搜索覆盖整轮推荐并忽略职位备注中的内部注释标记', () => {
  const first = recommendationPage(db, CID);
  const second = recommendationPage(db, CID, { cursor: first.next_cursor });
  const target = second.items[0];
  const row = db.prepare('SELECT notes FROM job_facts WHERE project_id=?').get(target.job.project_id);
  try {
    db.prepare('UPDATE job_facts SET notes=? WHERE project_id=?').run(
      '真实职位描述 EntireQueueSearchToken <!-- INTERNALONLYTOKEN -->', target.job.project_id,
    );
    const found = recommendationPage(db, CID, { search: 'entirequeuesearchtoken' });
    assert.equal(found.total_count, 1);
    assert.equal(found.items[0].job.project_id, target.job.project_id);
    assert.ok(found.items[0].rank > RECOMMENDATION_PAGE_SIZE);
    assert.equal(recommendationPage(db, CID, { search: 'internalonlytoken' }).total_count, 0);
  } finally {
    db.prepare('UPDATE job_facts SET notes=? WHERE project_id=?').run(row?.notes ?? null, target.job.project_id);
  }
});

test('搜索条件绑定分页游标，变化后必须从第一页重新搜索', () => {
  const ids = recommendationPage(db, CID).items.map((item) => item.job.project_id);
  const second = recommendationPage(db, CID, { cursor: recommendationPage(db, CID).next_cursor });
  ids.push(...second.items.slice(0, 5).map((item) => item.job.project_id));
  const originals = ids.map((id) => db.prepare('SELECT project_id, notes FROM job_facts WHERE project_id=?').get(id));
  try {
    const update = db.prepare('UPDATE job_facts SET notes=? WHERE project_id=?');
    for (const row of originals) update.run(`${row.notes || ''} BulkQueueSearchToken`, row.project_id);
    const page = recommendationPage(db, CID, { search: 'bulkqueuesearchtoken' });
    assert.equal(page.total_count, 25);
    assert.ok(page.next_cursor);
    const mismatch = recommendationPage(db, CID, { cursor: page.next_cursor });
    assert.equal(mismatch.code, 'INVALID_RECOMMENDATION_CURSOR');
    const next = recommendationPage(db, CID, { cursor: page.next_cursor, search: 'bulkqueuesearchtoken' });
    assert.equal(next.items.length, 5);
  } finally {
    const update = db.prepare('UPDATE job_facts SET notes=? WHERE project_id=?');
    for (const row of originals) update.run(row.notes ?? null, row.project_id);
  }
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
    assert.equal(payload.sort, 'priority');
    assert.equal(payload.items.length, RECOMMENDATION_PAGE_SIZE);
    assert.equal(payload.items[0].presentation_version, 'recommendation-presentation-1.0');
    assert.ok(payload.items[0].recent_activity === null || payload.items[0].recent_activity.occurred_at);
    assert.ok(payload.next_cursor);
    const query = payload.items[0].job.role;
    const searchedResponse = await fetch(`${base}/api/v1/recommendations?q=${encodeURIComponent(query)}`, { headers: { cookie } });
    assert.equal(searchedResponse.status, 200);
    const searched = await searchedResponse.json();
    assert.ok(searched.total_count > 0);
    assert.ok(searched.total_count <= payload.total_count);
    const recentResponse = await fetch(`${base}/api/v1/recommendations?sort=recent`, { headers: { cookie } });
    assert.equal(recentResponse.status, 200);
    assert.equal((await recentResponse.json()).sort, 'recent');
  } finally {
    server.close();
    if (previous === undefined) delete process.env.BRAINX_DEV_AUTH;
    else process.env.BRAINX_DEV_AUTH = previous;
  }
});
