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
    assert.equal((await duplicate.json()).already, true);
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
