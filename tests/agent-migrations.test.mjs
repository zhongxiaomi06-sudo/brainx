import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);

test('agent gateway migrations create every security and recovery table', () => {
  const db = openDb(':memory:');
  const expected = [
    'feishu_identity_bindings', 'agent_group_scopes', 'agent_runs', 'agent_tool_calls',
    'agent_nonces', 'agent_rate_limits', 'integration_jobs', 'integration_outbox',
    'agent_admin_events',
  ];
  const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  for (const table of expected) assert.ok(actual.includes(table), `${table} missing`);
});

test('identity bindings are app-scoped, revocable and cannot conflict while active', () => {
  const db = openDb(':memory:');
  assert.deepEqual(columns(db, 'feishu_identity_bindings'), [
    'binding_id', 'tenant_id', 'channel_account_id', 'feishu_app_key_hash', 'open_id',
    'union_id', 'consultant_id', 'employee_ref', 'binding_status', 'verified_at',
    'verified_by', 'revoked_at', 'created_at', 'updated_at',
  ]);
  const insert = db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id, tenant_id, channel_account_id, feishu_app_key_hash, open_id,
     consultant_id, binding_status, verified_at, verified_by, created_at, updated_at)
    VALUES (?, 'tenant-a', 'account-a', ?, 'ou-a', 'mia', 'ACTIVE', ?, 'admin', ?, ?)`);
  const at = new Date().toISOString();
  insert.run('binding-1', 'a'.repeat(64), at, at, at);
  assert.throws(() => insert.run('binding-2', 'a'.repeat(64), at, at, at), /UNIQUE/);
  assert.throws(() => db.prepare(`UPDATE feishu_identity_bindings SET binding_status='INVALID'
    WHERE binding_id='binding-1'`).run(), /CHECK/);
});

test('group, audit and nonce tables contain no raw prompt, resume or secret columns', () => {
  const db = openDb(':memory:');
  const auditColumns = [...columns(db, 'agent_runs'), ...columns(db, 'agent_tool_calls')];
  for (const forbidden of ['prompt', 'resume', 'phone', 'email', 'secret', 'token']) {
    assert.equal(auditColumns.some((name) => name.includes(forbidden)), false, forbidden);
  }
  assert.ok(columns(db, 'agent_group_scopes').includes('allowed_senders_json'));
  assert.ok(columns(db, 'agent_group_scopes').includes('project_refs_json'));
  assert.ok(columns(db, 'agent_nonces').includes('expires_at'));
});

test('integration jobs constrain terminal states and outbox deduplicates one result', () => {
  const db = openDb(':memory:');
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO integration_jobs
    (job_id, tenant_id, consultant_id, kind, idempotency_key, status, payload_json,
     attempts, max_attempts, cost_units, cost_limit, requested_at, updated_at)
    VALUES ('job-1','tenant-a','mia','TALENT_SYNC','idem-1','PENDING','{}',0,3,0,10,?,?)`).run(at, at);
  const outbox = db.prepare(`INSERT INTO integration_outbox
    (outbox_id, job_id, channel, account_id, target_hash, payload_ref, status,
     attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, 'job-1','feishu','account-a','hash-a','result:job-1','PENDING',0,?,?,?)`);
  outbox.run('out-1', at, at, at);
  assert.throws(() => outbox.run('out-2', at, at, at), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE integration_jobs SET status='LOST' WHERE job_id='job-1'").run(), /CHECK/);
});
