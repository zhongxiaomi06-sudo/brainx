import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.js';
import { createJobRepository } from '../src/integration-jobs/repository.js';
import { createOutbox } from '../src/integration-jobs/outbox.js';
import { runWorkerOnce } from '../src/integration-jobs/worker.js';

const t0 = new Date('2026-09-03T00:00:00.000Z');
const at = minutes => new Date(t0.getTime() + minutes * 60_000);

test('jobs are idempotent, leased, cost bounded, and recover after expiry', () => {
  const db = openDb(':memory:');
  const repo = createJobRepository(db);
  const first = repo.create({ tenantId: 'ttc', consultantId: 'mia', kind: 'SEARCH',
    idempotencyKey: 'search-1', payload: { query_ref: 'q-1' }, costLimit: 2, now: t0 });
  const duplicate = repo.create({ tenantId: 'ttc', consultantId: 'mia', kind: 'SEARCH',
    idempotencyKey: 'search-1', payload: { query_ref: 'q-1' }, costLimit: 2, now: t0 });
  assert.equal(duplicate.job_id, first.job_id);
  const claimed = repo.claim({ workerId: 'worker-a', leaseMs: 60_000, costUnits: 1, now: t0 });
  assert.equal(claimed.status, 'RUNNING');
  assert.equal(claimed.attempts, 1);
  assert.equal(repo.claim({ workerId: 'worker-b', now: at(0.5) }), null);
  const recovered = repo.claim({ workerId: 'worker-b', leaseMs: 60_000, costUnits: 1, now: at(2) });
  assert.equal(recovered.job_id, first.job_id);
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.cost_units, 2);
  repo.fail(first.job_id, 'worker-b', { code: 'TEMPORARY', retryable: true, now: at(2.5) });
  assert.equal(repo.get(first.job_id).status, 'FAILED', 'cost cap makes the second attempt terminal');
  assert.equal(repo.claim({ workerId: 'worker-c', costUnits: 1, now: at(3) }), null, 'cost cap blocks another attempt');
});

test('worker reaches a terminal state, supports cancellation, and stores no raw document', async () => {
  const db = openDb(':memory:');
  const repo = createJobRepository(db);
  assert.throws(() => repo.create({ tenantId: 'ttc', consultantId: 'mia', kind: 'PARSE_DOCUMENT',
    idempotencyKey: 'raw', payload: { text: 'raw resume' }, costLimit: 1, now: t0 }), /PAYLOAD_SENSITIVE/);
  const job = repo.create({ tenantId: 'ttc', consultantId: 'mia', kind: 'PARSE_DOCUMENT',
    idempotencyKey: 'parse-1', payload: { document_ref: 'object://resume-1' }, costLimit: 2, now: t0 });
  const outcome = await runWorkerOnce({ repository: repo, workerId: 'worker-a', now: t0,
    handlers: { PARSE_DOCUMENT: async payload => ({ result_ref: `${payload.document_ref}#facts` }) } });
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.equal(repo.get(job.job_id).result_ref, 'object://resume-1#facts');

  const cancelled = repo.create({ tenantId: 'ttc', consultantId: 'mia', kind: 'SEARCH',
    idempotencyKey: 'cancel-1', payload: { query_ref: 'q-2' }, costLimit: 1, now: at(1) });
  assert.equal(repo.cancel(cancelled.job_id, at(1)).status, 'CANCELLED');
  assert.equal(await runWorkerOnce({ repository: repo, workerId: 'worker-b', handlers: {}, now: at(2) }), null);
});

test('outbox deduplicates and reauthorizes immediately before delivery', async () => {
  const db = openDb(':memory:');
  const repo = createJobRepository(db);
  const job = repo.create({ tenantId: 'ttc', consultantId: 'mia', kind: 'SEARCH',
    idempotencyKey: 'notify-job', payload: { candidate_ref: 'candidate-1' }, costLimit: 1, now: t0 });
  const outbox = createOutbox(db);
  const first = outbox.enqueue({ jobId: job.job_id, channel: 'feishu', accountId: 'mia',
    targetHash: 'target-hash', payloadRef: 'candidate-1', now: t0 });
  const duplicate = outbox.enqueue({ jobId: job.job_id, channel: 'feishu', accountId: 'mia',
    targetHash: 'target-hash', payloadRef: 'candidate-1', now: t0 });
  assert.equal(duplicate.outbox_id, first.outbox_id);
  let sent = false;
  const result = await outbox.deliverNext({ now: t0,
    authorize: async () => false,
    send: async () => { sent = true; },
  });
  assert.equal(result.status, 'CANCELLED');
  assert.equal(sent, false);
});
