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
    assert.equal(payload.items[0].presentation_version, 'recommendation-presentation-1.0');
    assert.ok(payload.items[0].recent_activity === null || payload.items[0].recent_activity.occurred_at);
    assert.ok(payload.next_cursor);
  } finally {
    server.close();
    if (previous === undefined) delete process.env.BRAINX_DEV_AUTH;
    else process.env.BRAINX_DEV_AUTH = previous;
  }
});
