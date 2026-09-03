import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.js';
import { revokeTalentAccess } from '../src/talent-pipeline/grants.js';

function fakeTalentConnection() {
  const state = { active: true, committed: false, rolledBack: false };
  return {
    state,
    async beginTransaction() {},
    async commit() { state.committed = true; },
    async rollback() { state.rolledBack = true; },
    async execute(sql) {
      if (sql.includes('UPDATE talent_access_grants')) {
        const affectedRows = state.active ? 1 : 0;
        state.active = false;
        return [{ affectedRows }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
}

function seedOutbox(db) {
  const at = '2026-09-03T00:00:00.000Z';
  db.prepare(`INSERT INTO integration_jobs
    (job_id,tenant_id,consultant_id,kind,idempotency_key,status,payload_json,
     max_attempts,cost_units,cost_limit,requested_at,updated_at)
    VALUES ('job-revoke','ttc','mia','SEARCH','revoke-key','PENDING',?,3,0,10,?,?)`)
    .run(JSON.stringify({ talent_id: 42, candidate_ref: 'candidate-42' }), at, at);
  db.prepare(`INSERT INTO integration_outbox
    (outbox_id,job_id,channel,account_id,target_hash,payload_ref,status,attempts,
     next_attempt_at,created_at,updated_at)
    VALUES ('out-revoke','job-revoke','feishu','mia','hash','candidate-42','PENDING',0,?,?,?)`)
    .run(at, at, at);
}

test('revocation commits the grant first, then cancels notifications and invalidates derivatives', async () => {
  const conn = fakeTalentConnection();
  const db = openDb(':memory:');
  seedOutbox(db);
  const calls = [];
  const result = await revokeTalentAccess({
    conn, db, tenantId: 'ttc', talentId: 42, sourceAccountRef: 'mia-source',
    candidateRef: 'candidate-42', revokedAt: new Date('2026-09-03T01:00:00.000Z'),
    cache: { deleteCandidate: async ref => calls.push(`cache:${ref}`) },
    index: { deleteCandidate: async ref => calls.push(`index:${ref}`) },
  });
  assert.equal(conn.state.committed, true);
  assert.equal(result.revoked_grants, 1);
  assert.equal(result.cancelled_notifications, 1);
  assert.deepEqual(calls.sort(), ['cache:candidate-42', 'index:candidate-42']);
  assert.equal(db.prepare("SELECT status FROM integration_outbox WHERE outbox_id='out-revoke'").get().status, 'CANCELLED');
});

test('revocation is idempotent and a failed grant update never touches derivatives', async () => {
  const conn = fakeTalentConnection();
  conn.state.active = false;
  const db = openDb(':memory:');
  let invalidated = false;
  const result = await revokeTalentAccess({
    conn, db, tenantId: 'ttc', talentId: 42, sourceAccountRef: 'mia-source',
    candidateRef: 'candidate-42', cache: { deleteCandidate: async () => { invalidated = true; } },
  });
  assert.equal(result.revoked_grants, 0);
  assert.equal(invalidated, true);

  const failed = fakeTalentConnection();
  failed.execute = async () => { throw new Error('rds down'); };
  invalidated = false;
  await assert.rejects(() => revokeTalentAccess({
    conn: failed, db, tenantId: 'ttc', talentId: 42, sourceAccountRef: 'mia-source',
    candidateRef: 'candidate-42', cache: { deleteCandidate: async () => { invalidated = true; } },
  }), /rds down/);
  assert.equal(failed.state.rolledBack, true);
  assert.equal(invalidated, false);
});
