/** ttcsdk.test.mjs — TTC 凭据托管（轻无感）与 SDK 模块测试（2026-08-14）。
 * 纪律验证：JWT 永不出现在任何响应/状态里；过期与失效标记正确；端点只许本人。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// data/.secret 依赖：测试用临时目录（auth.js 读 ../../data/.secret 相对自身——用真实仓的 data/.secret 已有）
import { openDb } from '../src/db.js';
import { validateJwt, decodeJwt, saveTtcToken, getValidTtcJwt, markTtcReauth, ttcAuthStatus } from '../src/ttcsdk/auth.js';

let db;
before(() => { db = openDb(':memory:'); });

const makeJwt = ({ exp, nick = 'Wendy 郭雯', personId = 'X001' } = {}) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp, CustomData: { nick_name: nick }, personId })}.sig`;
};
const FUTURE = Math.floor(Date.now() / 1000) + 60 * 24 * 3600; // +60 天
const PAST = Math.floor(Date.now() / 1000) - 3600;

test('validateJwt：格式/缺 exp/过期/正常', () => {
  assert.throws(() => validateJwt('not-a-jwt'), /三段式/);
  assert.throws(() => validateJwt(makeJwt({ exp: null })), /缺 exp/);
  assert.throws(() => validateJwt(makeJwt({ exp: PAST })), /已过期/);
  const meta = validateJwt(makeJwt({ exp: FUTURE }));
  assert.equal(meta.userName, 'Wendy 郭雯');
  assert.equal(meta.personId, 'X001');
  assert.ok(Date.parse(meta.expiresAt) > Date.now());
});

test('托管往返：存取/状态视图不含 JWT/失效标记', () => {
  const jwt = makeJwt({ exp: FUTURE });
  saveTtcToken(db, 'wendy', jwt, validateJwt(jwt));
  assert.equal(getValidTtcJwt(db, 'wendy'), jwt); // 解密还原
  const st = ttcAuthStatus(db, 'wendy');
  assert.equal(st.connected, true);
  assert.equal(st.ttc_user_name, 'Wendy 郭雯');
  assert.ok(!JSON.stringify(st).includes(jwt)); // 状态视图绝不出 JWT 本体
  markTtcReauth(db, 'wendy');
  assert.equal(getValidTtcJwt(db, 'wendy'), null);
  assert.equal(ttcAuthStatus(db, 'wendy').needs_reauth, true);
});

test('过期 JWT：getValidTtcJwt → null，状态 needs_reauth', () => {
  // 直接构造过期行（validateJwt 会拦，模拟时间流逝后的状态）
  const jwt = makeJwt({ exp: FUTURE });
  saveTtcToken(db, 'linda', jwt, validateJwt(jwt));
  db.prepare(`UPDATE ttc_tokens SET expires_at=? WHERE consultant_id='linda'`)
    .run(new Date(Date.now() - 1000).toISOString());
  assert.equal(getValidTtcJwt(db, 'linda'), null);
  const st = ttcAuthStatus(db, 'linda');
  assert.equal(st.connected, false);
  assert.equal(st.needs_reauth, true);
});

test('未托管：connected=false', () => {
  assert.deepEqual(ttcAuthStatus(db, 'nobody'), { connected: false });
});

/* 端点 E2E：PUT 粘贴 → 活验证（打桩 fetch）→ 落库；GET 不回显 JWT；401 路径不落库 */
test('端点：PUT/GET /api/v1/ttc/connect 全链', async () => {
  const { createServer } = await import('../src/server.js');
  const { signSession } = await import('../src/session.js');
  const server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `brainx_session=${encodeURIComponent(signSession('shanon'))}`;
  const jwt = makeJwt({ exp: FUTURE, nick: 'Shanon 申莎娜' });
  const origFetch = globalThis.fetch;
  let authHeaderSeen = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('ttcadvisory.com')) { // TTC 活验证探针桩
      authHeaderSeen = opts.headers.Authorization;
      return new Response(JSON.stringify({ code: 0, data: { quota: 3 } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return origFetch(url, opts);
  };
  try {
    const put = await origFetch(`${base}/api/v1/ttc/connect`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ jwt }) });
    const out = await put.json();
    assert.equal(put.status, 200);
    assert.equal(out.connected, true);
    assert.equal(out.ttc_user_name, 'Shanon 申莎娜');
    assert.ok(authHeaderSeen?.startsWith('Bearer ')); // 活验证真的带了 JWT
    assert.ok(!JSON.stringify(out).includes(jwt));    // 响应不回显 JWT
    // GET 状态
    const get = await origFetch(`${base}/api/v1/ttc/connect`, { headers: { Cookie: cookie } });
    const st = await get.json();
    assert.equal(st.connected, true);
    assert.ok(!JSON.stringify(st).includes(jwt));
    // 库里是密文
    const row = db.prepare(`SELECT jwt_enc FROM ttc_tokens WHERE consultant_id='shanon'`).get();
    assert.ok(row.jwt_enc.startsWith('v1.') && !row.jwt_enc.includes(jwt));
  } finally {
    globalThis.fetch = origFetch;
    server.close();
  }
});

test('端点：TTC 侧 401 → PUT 返回 401 且不落库', async () => {
  const { createServer } = await import('../src/server.js');
  const { signSession } = await import('../src/session.js');
  const server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `brainx_session=${encodeURIComponent(signSession('mia'))}`;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).includes('ttcadvisory.com')
    ? new Response('unauthorized', { status: 401 })
    : origFetch(url, opts);
  try {
    const put = await origFetch(`${base}/api/v1/ttc/connect`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ jwt: makeJwt({ exp: FUTURE, nick: 'Mia 钟笑咪' }) }) });
    assert.equal(put.status, 401);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ttc_tokens WHERE consultant_id='mia'`).get().n, 0);
  } finally {
    globalThis.fetch = origFetch;
    server.close();
  }
});

/* —— 2026-09-04 账号隔离（强制本人登陆）：跨人代绑一律拒绝，fail-closed —— */
test('账号隔离：PUT 粘贴他人 JWT → 422 JWT_OWNER_MISMATCH 且不落库', async () => {
  const { createServer } = await import('../src/server.js');
  const { signSession } = await import('../src/session.js');
  const server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `brainx_session=${encodeURIComponent(signSession('mia'))}`;
  const origFetch = globalThis.fetch;
  let probed = false;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('ttcadvisory.com')) { probed = true; return new Response('{"code":0}', { status: 200 }); }
    return origFetch(url, opts);
  };
  try {
    // mia 的会话提交 wendy 名下的 JWT：归属不符必须在打 TTC 探针前拒绝
    const put = await origFetch(`${base}/api/v1/ttc/connect`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ jwt: makeJwt({ exp: FUTURE, nick: 'Wendy 郭雯' }) }) });
    const out = await put.json();
    assert.equal(put.status, 422);
    assert.equal(out.error?.code, 'JWT_OWNER_MISMATCH');
    assert.equal(probed, false, '归属不符时不得再消耗 TTC 活探针');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ttc_tokens WHERE consultant_id='mia'`).get().n, 0);
  } finally {
    globalThis.fetch = origFetch;
    server.close();
  }
});

test('账号隔离：ext-sync 缺 consultant_id 不再默认 felix；跨人 JWT 拒绝；ttc/status 收回需登录', async () => {
  const { createServer } = await import('../src/server.js');
  const server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const extHeaders = { 'Content-Type': 'application/json', Origin: 'chrome-extension://abcdef' };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => String(url).includes('ttcadvisory.com')
    ? new Response('{"code":0}', { status: 200 })
    : origFetch(url, opts);
  try {
    // 1) 缺 consultant_id → 422（原来默认 felix，属跨账号写入通道）
    const noCid = await origFetch(`${base}/api/v1/ttc/ext-sync`, {
      method: 'POST', headers: extHeaders,
      body: JSON.stringify({ jwt: makeJwt({ exp: FUTURE, nick: 'Felix 黄鑫' }) }) });
    assert.equal(noCid.status, 422);
    // 2) 指定顾问但 JWT 归属不符 → 422 且不落库
    const cross = await origFetch(`${base}/api/v1/ttc/ext-sync`, {
      method: 'POST', headers: extHeaders,
      body: JSON.stringify({ consultant_id: 'felix', jwt: makeJwt({ exp: FUTURE, nick: 'Mia 钟笑咪' }) }) });
    const crossOut = await cross.json();
    assert.equal(cross.status, 422);
    assert.equal(crossOut.error?.code, 'JWT_OWNER_MISMATCH');
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ttc_tokens WHERE consultant_id='felix'`).get().n, 0);
    // 3) 本人 JWT + 本人顾问 → 正常落库
    const own = await origFetch(`${base}/api/v1/ttc/ext-sync`, {
      method: 'POST', headers: extHeaders,
      body: JSON.stringify({ consultant_id: 'felix', jwt: makeJwt({ exp: FUTURE, nick: 'Felix 黄鑫' }) }) });
    assert.equal(own.status, 200);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ttc_tokens WHERE consultant_id='felix'`).get().n, 1);
    // 4) ttc/status 已从免登录名单收回：未登录 → 401，且不再接受 ?consultant_id= 跨人查询
    const anon = await origFetch(`${base}/api/v1/ttc/status?consultant_id=mia`);
    assert.equal(anon.status, 401);
  } finally {
    globalThis.fetch = origFetch;
    server.close();
  }
});
