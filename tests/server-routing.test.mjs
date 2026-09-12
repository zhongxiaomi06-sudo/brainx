/** server-routing.test.mjs — 路由层健壮性回归（H-1）。
 *
 * 背景：动态段匹配里的 decodeURIComponent 曾位于 handler try/catch 与鉴权之外，
 * GET /api/v1/opportunities/%zz（非法百分号编码）会以 async 回调 rejection 冒泡，
 * Node≥15 默认直接崩溃进程，且未登录即可触发。修复后应 400 收口、进程存活。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

let server, base;
before(async () => {
  const db = openDb(':memory:');
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.closeAllConnections?.(); server?.close(); });

test('H-1：非法百分号编码的动态段返回 400 而非崩溃', async () => {
  // fetch/URL 不会替我们编码，%zz 原样进 path
  const r = await fetch(`${base}/api/v1/opportunities/%zz`);
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.error?.code, 'INVALID_PATH');
});

test('H-1：解码失败后服务仍存活且正常响应', async () => {
  const r = await fetch(`${base}/api/v1/meta/guard`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok('per_minute' in d);
});

test('H-1：合法编码的动态段不受影响（仍走原 404/401 路径）', async () => {
  // 合法编码解码成功，进入 handler 层：未登录访问需鉴权的动态路由应 401，而非 400/崩溃
  const r = await fetch(`${base}/api/v1/opportunities/job%201`);
  assert.equal(r.status, 401);
});
