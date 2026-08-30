import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';

const PID = 'P-JOIN-FLOW';

function payload() {
  return {
    as_of: '2026-08-24T00:00:00.000Z',
    jobs: [{
      project_id: PID,
      company: '归属测试公司',
      role: '市场负责人',
      city: '上海',
      pipeline: '面试 2',
      hc: 2,
      active_state: 'OPEN',
      priority: 'NORMAL',
      notes: '',
      source_url: null,
      relation: 'NOT_JOINED',
      captured_at: '2026-08-24T00:00:00.000Z',
    }],
  };
}

test('HTTP：确认项目归属后解锁关注动作并保留关系历史', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: payload() });
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cookie = `brainx_session=${encodeURIComponent(signSession('felix', 'ou_felix'))}`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/${PID}/membership`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relation: 'MY_JOB', idempotency_key: 'membership:http:1' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.relation, 'MY_JOB');
    assert.ok(result.legal_actions.includes('WATCH'));
    assert.equal(result.project.project_id, PID);
    assert.equal(result.project.project_status, 'PENDING_START');
    assert.equal(result.recompute.deferred, true);

    const active = db.prepare(`SELECT relation FROM job_memberships
      WHERE consultant_id='felix' AND project_id=? AND valid_to IS NULL`).get(PID);
    assert.equal(active.relation, 'MY_JOB');
    const closed = db.prepare(`SELECT valid_to FROM job_memberships
      WHERE consultant_id='felix' AND project_id=? AND relation='NOT_JOINED'`).get(PID);
    assert.ok(closed.valid_to);

    const duplicate = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/${PID}/membership`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relation: 'MY_JOB', idempotency_key: 'membership:http:1' }),
    });
    assert.equal(duplicate.status, 200);
    const duplicateResult = await duplicate.json();
    assert.equal(duplicateResult.already, true);
    assert.equal(duplicateResult.recompute.deferred, false);

    const projectsResponse = await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      headers: { Cookie: cookie },
    });
    assert.equal(projectsResponse.status, 200);
    const projects = await projectsResponse.json();
    assert.equal(projects.total_count, 1);
    assert.equal(projects.items[0].project_id, PID);
    assert.equal(projects.items[0].relation, 'MY_JOB');
    assert.equal(projects.items[0].company, '归属测试公司');
    assert.equal(projects.items[0].engagement_state, 'NEW');
    assert.equal(projects.items[0].project_status, 'PENDING_START');

    const dueAt = new Date(Date.now() + 86400000).toISOString();
    const acceptResponse = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/${PID}/engagement`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'ACCEPT', confirm: true, goal: '验证闭环',
        action_title: '联系客户确认需求', due_at: dueAt, idempotency_key: 'membership:http:accept' }),
    });
    assert.equal(acceptResponse.status, 200);
    const progressing = await (await fetch(`http://127.0.0.1:${port}/api/v1/projects`, {
      headers: { Cookie: cookie },
    })).json();
    assert.equal(progressing.items[0].project_status, 'IN_PROGRESS');
    assert.equal(progressing.items[0].active_action.title, '联系客户确认需求');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('HTTP：项目归属只允许我的职位或团队共享', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: payload() });
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cookie = `brainx_session=${encodeURIComponent(signSession('felix', 'ou_felix'))}`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/${PID}/membership`, {
      method: 'PATCH',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relation: 'OTHER_CONSULTANT', idempotency_key: 'membership:http:bad' }),
    });
    assert.equal(response.status, 422);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('HTTP：全部职位中的团队共享池职位可以直接加入我的项目', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: payload() });
  db.prepare('DELETE FROM job_memberships WHERE consultant_id=? AND project_id=?').run('felix', PID);
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const cookie = `brainx_session=${encodeURIComponent(signSession('felix', 'ou_felix'))}`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/opportunities/${PID}/membership`, {
      method: 'PATCH', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ relation: 'MY_JOB', idempotency_key: 'membership:http:shared-pool' }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.project.project_id, PID);
    assert.equal(result.project.relation, 'MY_JOB');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});

test('HTTP：待开始项目可忽略并关闭归属历史，跟进中项目拒绝直接移除', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: payload() });
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api/v1/opportunities/${PID}`;
  const headers = { Cookie: `brainx_session=${encodeURIComponent(signSession('felix', 'ou_felix'))}`,
    'Content-Type': 'application/json' };
  try {
    await fetch(`${base}/membership`, { method: 'PATCH', headers,
      body: JSON.stringify({ relation: 'MY_JOB', idempotency_key: 'membership:remove:join' }) });
    const removed = await fetch(`${base}/membership`, { method: 'DELETE', headers,
      body: JSON.stringify({ idempotency_key: 'membership:remove:1' }) });
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).removed, true);
    assert.equal(db.prepare(`SELECT COUNT(*) count FROM job_memberships
      WHERE consultant_id='felix' AND project_id=? AND valid_to IS NULL
        AND relation IN ('MY_JOB','TEAM_SHARED')`).get(PID).count, 0);

    const duplicate = await fetch(`${base}/membership`, { method: 'DELETE', headers,
      body: JSON.stringify({ idempotency_key: 'membership:remove:1' }) });
    assert.equal((await duplicate.json()).already, true);

    await fetch(`${base}/membership`, { method: 'PATCH', headers,
      body: JSON.stringify({ relation: 'MY_JOB', idempotency_key: 'membership:remove:rejoin' }) });
    const dueAt = new Date(Date.now() + 86400000).toISOString();
    await fetch(`${base}/engagement`, { method: 'POST', headers,
      body: JSON.stringify({ action: 'ACCEPT', confirm: true, goal: '继续推进',
        action_title: '联系客户', due_at: dueAt, idempotency_key: 'membership:remove:accept' }) });
    const blocked = await fetch(`${base}/membership`, { method: 'DELETE', headers,
      body: JSON.stringify({ idempotency_key: 'membership:remove:blocked' }) });
    assert.equal(blocked.status, 409);
    assert.match((await blocked.json()).error.message, /结束当前动作/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
