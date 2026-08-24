/** snapshot.test.mjs — 职位快照接口：API Key 鉴权 + 过滤参数 + 无 key 拒绝。
 * 关键场景：外部系统（York AI worker）无 brainx session，仅凭 API Key 读取——验证该路径。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';

let db, server, base;

before(async () => {
  process.env.BRAINX_SNAPSHOT_API_KEY = 'test-snapshot-key-2026';
  db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.closeAllConnections?.(); server?.close(); });

test('snapshot：无 API Key → 401 INVALID_API_KEY', async () => {
  const r = await fetch(`${base}/api/v1/jobs/snapshot`);
  assert.equal(r.status, 401);
  const d = await r.json();
  assert.equal(d.error.code, 'INVALID_API_KEY');
});

test('snapshot：错误 API Key → 401', async () => {
  const r = await fetch(`${base}/api/v1/jobs/snapshot`, {
    headers: { Authorization: 'Bearer wrong-key' },
  });
  assert.equal(r.status, 401);
});

test('snapshot：外部系统（无 session 仅 API Key）→ 200，返回全量职位', async () => {
  const r = await fetch(`${base}/api/v1/jobs/snapshot`, {
    headers: { Authorization: 'Bearer test-snapshot-key-2026' },
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.total > 0, '应返回职位');
  assert.ok(d.total_count >= d.total, 'total_count 应不小于返回条数');
  assert.ok(d.served_at, '应包含 served_at');
  assert.ok(d.jobs[0].project_id, '每条应有 project_id');
  assert.ok(d.jobs[0].company, '每条应有 company');
  assert.equal(d.jobs[0].raw_json, undefined, '不应泄露 raw_json');
});

test('snapshot：updated_after 过滤', async () => {
  const r = await fetch(`${base}/api/v1/jobs/snapshot?updated_after=2099-01-01T00:00:00Z`, {
    headers: { Authorization: 'Bearer test-snapshot-key-2026' },
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.total, 0, '未来时间应无结果');
  assert.equal(d.total_count, 0);
});

test('snapshot：limit 截断返回，total_count 仍为全量匹配数', async () => {
  const r = await fetch(`${base}/api/v1/jobs/snapshot?limit=3`, {
    headers: { Authorization: 'Bearer test-snapshot-key-2026' },
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.total, 3);
  assert.equal(d.jobs.length, 3);
  assert.ok(d.total_count >= 3, 'limit 不应影响计数');
});

test('snapshot：status 过滤', async () => {
  const r = await fetch(`${base}/api/v1/jobs/snapshot?status=OPEN`, {
    headers: { Authorization: 'Bearer test-snapshot-key-2026' },
  });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.ok(d.jobs.every((j) => j.active_state === 'OPEN'));
});
