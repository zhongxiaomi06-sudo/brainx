/** guard.test.mjs — 预测告警装置：指标埋点、检测阈值、突发流量集成（实测告警触发）。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, detect } from '../src/guard.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';

test('createGuard：record 计数与字节量进入当前桶', () => {
  const g = createGuard();
  const req = { method: 'GET', url: '/api/v1/x', headers: { 'content-length': '42' } };
  const res = { end: (c) => c, writeHead: () => {} };
  g.record(req, res);
  const s = g.snapshot();
  assert.equal(s.per_minute.total, 1);
  assert.equal(s.per_minute.bytes_in, 42);
  assert.equal(s.per_minute.by_route['GET /api/v1/x'], 1);
});

test('detect：冷启动只建基线不告警', () => {
  const snap = { window_s: 60, per_minute: { total: 100, bytes_in: 1, bytes_out: 1, by_route: {} } };
  const out = detect(snap, null, { maxRpm: 50 });
  assert.equal(out.alerted, false);
  assert.equal(out.reason, 'warming');
  assert.equal(out.baseline.rpm, 100);
});

test('detect：超过绝对阈值告警', () => {
  const snap = { window_s: 60, per_minute: { total: 999, bytes_in: 0, bytes_out: 0, by_route: {} } };
  const prev = { rpm: 10, bps: 0 };
  const out = detect(snap, prev, { maxRpm: 600 });
  assert.equal(out.alerted, true);
  assert.ok(out.alerts.some((a) => a.includes('999 rpm')));
});

test('detect：相对基线突增告警（预测外推）', () => {
  const snap = { window_s: 60, per_minute: { total: 500, bytes_in: 0, bytes_out: 0, by_route: {} } };
  const prev = { rpm: 20, bps: 0 };
  const out = detect(snap, prev, { maxRpm: 99999, spikeMult: 3 });
  assert.equal(out.alerted, true);
  assert.ok(out.alerts.some((a) => a.includes('突增')));
});

test('detect：带宽爆炸告警', () => {
  const snap = { window_s: 60, per_minute: { total: 10, bytes_in: 600 * 1024 * 1024, bytes_out: 0, by_route: {} } };
  const prev = { rpm: 10, bps: 0 };
  const out = detect(snap, prev, { maxRpm: 99999, maxBps: 5 * 1024 * 1024 });
  assert.equal(out.alerted, true);
  assert.ok(out.alerts.some((a) => a.includes('带宽')));
});

test('detect：单路由洪峰告警', () => {
  const snap = { window_s: 60, per_minute: { total: 300, bytes_in: 0, bytes_out: 0,
    by_route: { 'GET /api/v1/jobs/snapshot': 300 } } };
  const prev = { rpm: 10, bps: 0 };
  const out = detect(snap, prev, { maxRpm: 99999, spikeMult: 99, maxRouteRpm: 240 });
  assert.equal(out.alerted, true);
  assert.ok(out.alerts.some((a) => a.includes('路由洪峰')));
});

let server, base;
before(async () => {
  process.env.BRAINX_SNAPSHOT_API_KEY = 'guard-test-key';
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.closeAllConnections?.(); server?.close(); });

test('集成：/api/v1/meta/guard 免登录可达且结构正确', async () => {
  const r = await fetch(`${base}/api/v1/meta/guard`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(Array.isArray(d.history));
  assert.ok('per_minute' in d);
  assert.ok('by_route' in d.per_minute);
});

test('集成：突发流量实测——400 次快照请求触发告警', async () => {
  const warm = await (await fetch(`${base}/api/v1/meta/guard`)).json();
  const warmOut = detect(warm, null, { maxRpm: 300, maxRouteRpm: 200, spikeMult: 2 });
  const jobs = [];
  for (let i = 0; i < 400; i++) {
    jobs.push(fetch(`${base}/api/v1/jobs/snapshot`, {
      headers: { Authorization: 'Bearer guard-test-key' },
    }).catch(() => null));
    if (i % 100 === 99) await new Promise((r) => setTimeout(r, 200));
  }
  await Promise.all(jobs);
  const snap = await (await fetch(`${base}/api/v1/meta/guard`)).json();
  const bucketResults = snap.history.map((bucket) => detect({
    window_s: snap.window_s,
    per_minute: {
      total: bucket.req,
      bytes_in: bucket.bytes_in,
      bytes_out: bucket.bytes_out,
      by_route: bucket.by_route,
    },
  }, warmOut.baseline, { maxRpm: 300, maxRouteRpm: 200, spikeMult: 2 }));
  assert.equal(
    bucketResults.some((out) => out.alerted),
    true,
    `应触发告警，alerts=${JSON.stringify(bucketResults.flatMap((out) => out.alerts))}`,
  );
});
