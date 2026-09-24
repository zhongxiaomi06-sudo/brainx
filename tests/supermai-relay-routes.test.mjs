import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import { getSupermaiResult, startSupermaiScoutTask,
  supermaiCriteriaKey } from '../src/supermai-sourcing.js';

const cookie = (consultant = 'felix') => ({
  Cookie: `brainx_session=${encodeURIComponent(signSession(consultant, `ou_${consultant}`))}`,
});

async function post(url, payload, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(payload) });
}

test('HTTP 全链路：会话生成配对码，设备领任务，任务 token ingest/finish', async () => {
  const previous = process.env.BRAINX_ALLOW_HTTP_LOOPBACK;
  process.env.BRAINX_ALLOW_HTTP_LOOPBACK = '1';
  const db = openDb(':memory:');
  const server = createServer(db, {
    connections: { readReloopHealth: async () => ({ ready: false }) },
    supermaiRelay: { baseUrl: 'http://127.0.0.1:3999' },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await post(`${base}/api/v1/connections/supermai/pairing-code`, {});
    assert.equal(denied.status, 401);
    const pairResponse = await post(`${base}/api/v1/connections/supermai/pairing-code`, {}, cookie());
    assert.equal(pairResponse.status, 201);
    const pair = await pairResponse.json();
    assert.match(pair.code, /^(?:[A-F0-9]{4}-){3}[A-F0-9]{4}$/);

    const claimResponse = await post(`${base}/api/v1/supermai/pair/claim`, {
      code: pair.code, name: '测试 Mac', platform: 'darwin', connector_version: '1.0.0',
    });
    assert.equal(claimResponse.status, 201);
    const claimed = await claimResponse.json();
    const auth = { Authorization: `Bearer ${claimed.device_token}` };

    const task = startSupermaiScoutTask(db, null, 'felix', '北京 AI 产品经理');
    const pollResponse = await post(`${base}/api/v1/supermai/relay/poll`, {
      connector_version: '1.0.0', local: { available: true, busy: false, version: '0.3.6',
        platforms: { boss: { running: true, logged_in: true } } },
    }, auth);
    assert.equal(pollResponse.status, 200);
    const work = await pollResponse.json();
    assert.equal(work.kind, 'sourcing_task');
    assert.equal(work.task_id, task.task_id);
    assert.equal(work.ingest.url,
      `http://127.0.0.1:3999/api/v1/sourcing/tasks/${encodeURIComponent(task.task_id)}/ingest`);

    const ingest = await post(`${base}/api/v1/sourcing/tasks/${task.task_id}/ingest`, {
      platform: 'boss', items: [{ platform: 'boss', external_id: 'boss:one', name: '王五',
        company: '示例公司', title: '产品经理', city: '北京' }],
    }, { 'X-Ingest-Token': work.ingest.token });
    assert.equal(ingest.status, 200);
    assert.deepEqual(await ingest.json(), { code: 0,
      data: { accepted: 1, deduped: 0, statuses: {} } });
    const finish = await post(`${base}/api/v1/sourcing/tasks/${task.task_id}/finish`, {
      status: 'done', platform_counts: { boss: 1 },
    }, { 'X-Ingest-Token': work.ingest.token });
    assert.equal(finish.status, 200);
    assert.deepEqual(await finish.json(), { code: 0,
      data: { status: 'completed', result_count: 1 } });
    const result = getSupermaiResult(db, 'felix', supermaiCriteriaKey('北京 AI 产品经理'));
    assert.equal(result.status, 'done');
    assert.match(result.result_text, /王五/);

    const source = await fetch(`${base}/api/v1/supermai/connector/source`);
    assert.equal(source.status, 200);
    assert.match(await source.text(), /BrainX SuperMai Connector/);
    const installer = await fetch(`${base}/api/v1/supermai/connector/install`);
    assert.equal(installer.status, 200);
    assert.equal(installer.headers.get('content-type'), 'application/zip');
    const archive = Buffer.from(await installer.arrayBuffer());
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.ok(archive.includes(Buffer.from('api/v1/supermai/connector/source')));
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    if (previous === undefined) delete process.env.BRAINX_ALLOW_HTTP_LOOPBACK;
    else process.env.BRAINX_ALLOW_HTTP_LOOPBACK = previous;
  }
});

test('开放 relay 端点没有设备 token 时一律拒绝', async () => {
  const db = openDb(':memory:');
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await post(`${base}/api/v1/supermai/relay/poll`, { local: {} })).status, 401);
    assert.equal((await post(`${base}/api/v1/supermai/relay/report`, { task_id: 'x' })).status, 401);
    assert.equal((await post(`${base}/api/v1/sourcing/tasks/x/ingest`, {
      platform: 'boss', items: [],
    }, { 'X-Ingest-Token': 'wrong' })).status, 401);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
