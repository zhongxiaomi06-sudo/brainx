import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';

const PID = 'P-ACCEPT-LAUNCH';

function payload() {
  return {
    as_of: '2026-09-10T00:00:00.000Z',
    jobs: [{
      project_id: PID, company: '拉群测试公司', role: '测试负责人', city: '北京',
      pipeline: '', hc: 1, active_state: 'OPEN', priority: 'NORMAL', notes: '',
      source_url: null, relation: 'NOT_JOINED', captured_at: '2026-09-10T00:00:00.000Z',
    }],
  };
}

async function prepare(db) {
  runSync(db, { source: 'test', consultant_id: 'felix', payload: payload() });
  // preflight 需要：顾问 open_id + ACTIVE 绑定
  db.prepare(`UPDATE consultants SET open_id='ou_felix' WHERE consultant_id='felix'`).run();
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id, tenant_id, channel_account_id, feishu_app_key_hash, open_id, consultant_id,
     binding_status, verified_at, verified_by, created_at, updated_at)
    VALUES ('b-1', 'tenant-a', 'mia', '${'a'.repeat(64)}', 'ou_felix', 'felix',
     'ACTIVE', '2026-09-10T00:00:00.000Z', 'test', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z')`).run();
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const port = server.address().port;
  const cookie = `brainx_session=${encodeURIComponent(signSession('felix', 'ou_felix'))}`;
  // 建立 MY_JOB 归属（preflight 必需）
  const joined = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/${PID}/membership`, {
    method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ relation: 'MY_JOB', idempotency_key: 'accept-launch:join' }),
  });
  assert.equal(joined.status, 200);
  return { server, port, cookie };
}

const acceptBody = () => ({ action: 'ACCEPT', goal: '找到候选人', action_title: '启动找人',
  due_at: new Date(Date.now() + 2 * 86400000).toISOString(), idempotency_key: 'accept-launch:1' });

test('HTTP：web 接单成功后自动拉项目群（specs/011）', async () => {
  const db = openDb(':memory:');
  const created = [];
  const { server, port, cookie } = await prepare(db);
  // 重新创建带 projectLaunch 依赖的服务器（prepare 里的 server 不带依赖，仅用于归属）
  await new Promise((resolve) => server.close(resolve));
  const launchDeps = {
    appConfigured: true, publicBaseUrl: 'https://brainx.example.com',
    createProjectChat: async (input) => { created.push(input); return { chat_id: 'oc_launch_test', name: input.name }; },
    sendInteractiveCard: async () => ({ message_id: 'msg-1' }),
    ensureOpenClawGroupAllowed: async () => {},
  };
  const server2 = createServer(db, { projectLaunch: launchDeps });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const port2 = server2.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port2}/api/v1/opportunities/${PID}/engagement`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(acceptBody()),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.state, 'ACCEPTED');
    assert.equal(result.project_launch?.ok, true, '拉群应随接单成功');
    assert.equal(result.project_launch.launch.status, 'READY');
    assert.equal(result.project_launch.launch.chat_id, 'oc_launch_test');
    assert.equal(created.length, 1);
    assert.equal(created[0].ownerOpenId, 'ou_felix', '群主=顾问本人');
    const launchRow = db.prepare(`SELECT status, chat_id FROM project_launches WHERE project_id=?`).get(PID);
    assert.equal(launchRow.status, 'READY');
    assert.equal(launchRow.chat_id, 'oc_launch_test');
    const chat = db.prepare('SELECT chat_id FROM job_facts WHERE project_id=?').get(PID);
    assert.equal(chat.chat_id, 'oc_launch_test', '职位应挂载项目群');
  } finally { await new Promise((resolve) => server2.close(resolve)); }
});

test('HTTP：拉群失败不阻塞接单返回（specs/011）', async () => {
  const db = openDb(':memory:');
  const { port, cookie } = await prepare(db);
  const server2 = createServer(db, { projectLaunch: {
    appConfigured: true, publicBaseUrl: 'https://brainx.example.com',
    createProjectChat: async () => { throw new Error('FEISHU_DOWN'); },
    sendInteractiveCard: async () => ({ message_id: 'msg-1' }),
    ensureOpenClawGroupAllowed: async () => {},
  } });
  await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve));
  const port2 = server2.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port2}/api/v1/opportunities/${PID}/engagement`, {
      method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify(acceptBody()),
    });
    assert.equal(response.status, 200, '接单本身必须成功');
    const result = await response.json();
    assert.equal(result.state, 'ACCEPTED');
    assert.equal(result.project_launch?.ok, false);
    assert.equal(result.project_launch.code, 'FEISHU_CHAT_CREATE_FAILED');
  } finally {
    server2.closeAllConnections?.();
    await new Promise((resolve) => server2.close(resolve));
    db.close();
  }
});
