import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import { getSupermaiCredentials, saveSupermaiCredentials, supermaiScoutMatch } from '../src/supermai-sourcing.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';
const EXPECTED_BASE = process.env.BRAINX_SUPERMAI_CLOUD_BASE_URL
  || 'https://app.ttcadvisory.com/app/sourcing/api/sourcing/v1';

test('SuperMai 凭证在无独立凭证时回退本人 TTC JWT（标记 ttc_jwt，调用时兑换 sourcing token）', () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const creds = getSupermaiCredentials(db, 'felix');
  assert.ok(creds, '应有凭证（回退到 JWT）');
  assert.equal(creds.token, JWT, 'token 应等于顾问本人 TTC JWT');
  assert.equal(creds.ttc_jwt, true, '应标记需要兑换 sourcing token');
  assert.equal(creds.cloudBaseUrl, EXPECTED_BASE, '默认指向 sourcing web API 前缀');
});

test('SuperMai 独立凭证表优先于 TTC JWT 兑换（视为已持有的 sourcing token）', () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  saveSupermaiCredentials(db, 'felix', 'https://sourcing.example.com', 'independent-sourcing-token');
  const creds = getSupermaiCredentials(db, 'felix');
  assert.equal(creds.cloudBaseUrl, 'https://sourcing.example.com');
  assert.equal(creds.token, 'independent-sourcing-token');
  assert.equal(creds.ttc_jwt, undefined, '独立凭证不再兑换');
});

test('无任何凭证时返回 null（fail-closed，不抛异常）', () => {
  const db = openDb(':memory:');
  assert.equal(getSupermaiCredentials(db, 'felix'), null);
});

test('账号隔离：共享环境变量 token 不再作为全员回退（2026-09-04 加固沿用）', () => {
  const db = openDb(':memory:');
  const orig = process.env.BRAINX_SUPERMAI_TOKEN;
  process.env.BRAINX_SUPERMAI_TOKEN = 'shared-account-token';
  try {
    // 未绑定本人 JWT → 必须不可用，绝不能借共享 token 搜（那就是拿别人的账号）
    assert.equal(getSupermaiCredentials(db, 'felix'), null);
    // 绑定了本人 JWT → 只用本人的
    saveTtcToken(db, 'felix', JWT, {
      userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(getSupermaiCredentials(db, 'felix')?.token, JWT);
  } finally {
    if (orig === undefined) delete process.env.BRAINX_SUPERMAI_TOKEN;
    else process.env.BRAINX_SUPERMAI_TOKEN = orig;
  }
});

/** 按路径+方法路由的 mock fetch，记录全部调用便于断言。 */
function mockSourcingFetch(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    const hit = routes.find((r) => u.includes(r.path) && (!r.method || (init.method || 'GET') === r.method));
    calls.push({ path: u.replace(/^https?:\/\/[^/]+/, ''), method: init.method || 'GET' });
    if (!hit) return Response.json({ code: 1, message: `unexpected ${u}` }, { status: 404 });
    if (hit.status) return new Response(hit.body ?? '', { status: hit.status });
    return Response.json(hit.json ?? { code: 0, data: {} });
  };
  return calls;
}

test('E2E：TTC JWT 兑换 → 三渠道 sql_query + 领英库内+外部解析管线 → 合并去重', async () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const creds = getSupermaiCredentials(db, 'felix');
  const calls = mockSourcingFetch([
    { path: '/auth/login', method: 'POST', json: { code: 0, data: { token: 'sourcing-token-1' } } },
    { path: '/sessions', method: 'POST', json: { code: 0, data: { id: 'sess-1' } } },
    { path: '/chat/sql_query', method: 'POST', json: { code: 0, data: { candidates: [
      { id: 'g1', name: '张三', current_title: '算法工程师', current_company: 'Acme', github_url: 'https://github.com/zs' },
    ] } } },
    { path: '/chat/quick_db_search', method: 'POST', json: { code: 0, data: { candidates: [
      { id: 'l1', name: '李四', current_title: 'Engineer', current_company: 'Beta', linkedin_url: 'https://linkedin.com/in/l4' },
    ], raw_count: 5, filtered_count: 1 } } },
    { path: '/chat/quick_search_urls', method: 'POST', json: { code: 0, data: { exa_results: [{ url: 'https://linkedin.com/in/ext1' }], sources: ['exa'] } } },
    { path: '/chat/start_background_parse', method: 'POST', json: { code: 0, data: {} } },
    { path: '/chat/task_status/sess-1', json: { code: 0, data: { status: 'completed', candidates: [
      { id: 'l1', name: '李四', current_title: 'Engineer' }, // 与库内重复 → 去重
      { id: 'ext1', name: 'Wang Wu', current_title: 'Staff Engineer' },
    ] } } },
  ]);
  try {
    const out = await supermaiScoutMatch({
      criteria: '北京 5年 React 资深前端工程师', sources: ['linkedin', 'bonjour', 'paper', 'github'], limit: 10,
      _credentials: creds,
    });
    assert.equal(out.schema_version, 'supermai_scout_match_v2');
    const names = out.top_candidates.map((c) => c.name);
    assert.deepEqual(names.sort(), ['Wang Wu', '张三', '李四'].sort(), '三渠道合并且库内/外部重复只留一条');
    assert.ok(out.top_candidates.every((c) => c.source_cn && c.source), '归一结果带渠道中文名');
    assert.equal(out.unknowns.length, 0, '全链路成功时无 unknowns');
    const paths = calls.map((c) => c.path.split('?')[0].replace(/^.*\/sourcing\/v1|.*\/sourcing\/api/, ''));
    assert.ok(calls.some((c) => c.path.includes('/auth/login')), '先兑换 sourcing token');
    assert.ok(calls.some((c) => c.path.endsWith('/sessions')), '创建会话');
    assert.ok(calls.filter((c) => c.path.includes('/chat/sql_query')).length === 3, 'bonjour/paper/github 三渠道');
    assert.ok(calls.some((c) => c.path.includes('/chat/task_status/sess-1')), '轮询外部解析任务');
  } finally {
    global.fetch = undefined;
  }
});

test('领英外部管线失败 → 降级为库内结果 + unknowns 注记（不判整链不可用）', async () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const creds = getSupermaiCredentials(db, 'felix');
  mockSourcingFetch([
    { path: '/auth/login', method: 'POST', json: { code: 0, data: { token: 'st' } } },
    { path: '/sessions', method: 'POST', json: { code: 0, data: { id: 'sess-2' } } },
    { path: '/chat/sql_query', method: 'POST', json: { code: 0, data: { candidates: [
      { id: 'b1', name: '赵六', current_title: 'PM' },
    ] } } },
    { path: '/chat/quick_db_search', method: 'POST', json: { code: 0, data: { candidates: [
      { id: 'l2', name: '孙七', current_title: 'Engineer' },
    ] } } },
    { path: '/chat/quick_search_urls', method: 'POST', status: 500, body: 'boom' },
  ]);
  try {
    const out = await supermaiScoutMatch({ criteria: 'AI 产品负责人 上海', _credentials: creds });
    const names = out.top_candidates.map((c) => c.name).sort();
    assert.deepEqual(names, ['孙七', '赵六']);
    assert.ok(out.unknowns.some((u) => u.includes('领英外部')), '外部失败要有 unknowns 注记');
  } finally {
    global.fetch = undefined;
  }
});

test('所有渠道都失败 → SUPERMAI_UNAVAILABLE（附首因消息）', async () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const creds = getSupermaiCredentials(db, 'felix');
  mockSourcingFetch([
    { path: '/auth/login', method: 'POST', json: { code: 0, data: { token: 'st' } } },
    { path: '/sessions', method: 'POST', status: 503, body: '<html>alb</html>' },
    { path: '/chat/sql_query', method: 'POST', status: 404, body: '404 Not Found' },
    { path: '/chat/quick_db_search', method: 'POST', status: 404, body: '404 Not Found' },
  ]);
  try {
    await assert.rejects(
      () => supermaiScoutMatch({ criteria: '资深算法工程师', _credentials: creds }),
      (error) => { assert.equal(error.code, 'SUPERMAI_UNAVAILABLE'); return true; },
    );
  } finally {
    global.fetch = undefined;
  }
});

test('sourcing 检索中 401 → AUTH_EXPIRED（调用方据此标记重登）', async () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const creds = getSupermaiCredentials(db, 'felix');
  mockSourcingFetch([
    { path: '/auth/login', method: 'POST', json: { code: 0, data: { token: 'st' } } },
    { path: '/sessions', method: 'POST', status: 401, body: '' },
  ]);
  try {
    await assert.rejects(
      () => supermaiScoutMatch({ criteria: '资深算法工程师', _credentials: creds }),
      (error) => { assert.equal(error.code, 'AUTH_EXPIRED'); return true; },
    );
  } finally {
    global.fetch = undefined;
  }
});

test('criteria 过短 → INVALID_ARGUMENT（不打外部接口）', async () => {
  await assert.rejects(
    () => supermaiScoutMatch({ criteria: '短', _credentials: { token: 'x' } }),
    (error) => { assert.equal(error.code, 'INVALID_ARGUMENT'); return true; },
  );
});

test('无凭证注入且无凭据 → SUPERMAI_UNAVAILABLE（不发起任何请求）', async () => {
  const origFetch = global.fetch;
  let called = 0;
  global.fetch = async () => { called += 1; return Response.json({ code: 0, data: {} }); };
  try {
    await assert.rejects(
      () => supermaiScoutMatch({ criteria: '资深算法工程师', _credentials: null }),
      (error) => { assert.equal(error.code, 'SUPERMAI_UNAVAILABLE'); return true; },
    );
    assert.equal(called, 0, '无凭证时不得发起请求');
  } finally {
    global.fetch = origFetch;
  }
});
