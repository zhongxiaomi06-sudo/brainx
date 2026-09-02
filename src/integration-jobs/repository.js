import { randomUUID } from 'node:crypto';

const KINDS = new Set(['TALENT_SYNC', 'PARSE_DOCUMENT', 'MATCH_EVAL', 'SEARCH']);
const SENSITIVE_KEYS = new Set(['text', 'content', 'resume', 'prompt', 'file_bytes']);
const iso = value => (value instanceof Date ? value : new Date(value || Date.now())).toISOString();

function validatePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PAYLOAD_INVALID');
  const walk = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) throw new Error('PAYLOAD_SENSITIVE');
      walk(child);
    }
  };
  walk(value);
  const encoded = JSON.stringify(value);
  if (encoded.length > 16_384) throw new Error('PAYLOAD_TOO_LARGE');
  return encoded;
}

function row(db, id) {
  const value = db.prepare('SELECT * FROM integration_jobs WHERE job_id=?').get(id);
  return value ? { ...value, payload: JSON.parse(value.payload_json) } : null;
}

export function createJobRepository(db) {
  return Object.freeze({
    get: id => row(db, id),
    create(input) {
      if (!KINDS.has(input.kind)) throw new Error('JOB_KIND_INVALID');
      const now = iso(input.now);
      const payloadJson = validatePayload(input.payload || {});
      const existing = db.prepare('SELECT job_id FROM integration_jobs WHERE idempotency_key=?').get(input.idempotencyKey);
      if (existing) return row(db, existing.job_id);
      const jobId = input.jobId || randomUUID();
      db.prepare(`INSERT INTO integration_jobs
        (job_id,tenant_id,consultant_id,kind,idempotency_key,status,payload_json,
         max_attempts,cost_units,cost_limit,requested_at,updated_at)
        VALUES (?,?,?,?,?,'PENDING',?,?,0,?,?,?)`).run(
        jobId, input.tenantId, input.consultantId, input.kind, input.idempotencyKey,
        payloadJson, input.maxAttempts || 3, input.costLimit ?? 0, now, now,
      );
      return row(db, jobId);
    },
    claim({ workerId, kinds = [...KINDS], leaseMs = 60_000, costUnits = 0, now = new Date() }) {
      if (!Array.isArray(kinds) || !kinds.length) return null;
      if (kinds.some(kind => !KINDS.has(kind))) throw new Error('JOB_KIND_INVALID');
      const current = iso(now);
      const lease = new Date(new Date(current).getTime() + leaseMs).toISOString();
      const kindSlots = kinds.map(() => '?').join(',');
      db.exec('BEGIN IMMEDIATE');
      try {
        const candidate = db.prepare(`SELECT job_id FROM integration_jobs
          WHERE (status='PENDING' OR (status='RUNNING' AND lease_expires_at<=?))
            AND attempts < max_attempts AND cost_units + ? <= cost_limit AND kind IN (${kindSlots})
          ORDER BY requested_at, job_id LIMIT 1`).get(current, costUnits, ...kinds);
        if (!candidate) {
          db.exec('COMMIT');
          return null;
        }
        const changed = db.prepare(`UPDATE integration_jobs SET status='RUNNING',lease_owner=?,
          lease_expires_at=?,attempts=attempts+1,cost_units=cost_units+?,
          started_at=COALESCE(started_at,?),updated_at=?
          WHERE job_id=? AND (status='PENDING' OR (status='RUNNING' AND lease_expires_at<=?))`)
          .run(workerId, lease, costUnits, current, current, candidate.job_id, current);
        const claimed = changed.changes ? row(db, candidate.job_id) : null;
        db.exec('COMMIT');
        return claimed;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    complete(jobId, workerId, { resultRef, now = new Date() } = {}) {
      const current = iso(now);
      const changed = db.prepare(`UPDATE integration_jobs SET status='SUCCEEDED',result_ref=?,
        lease_owner=NULL,lease_expires_at=NULL,completed_at=?,updated_at=?
        WHERE job_id=? AND status='RUNNING' AND lease_owner=?`)
        .run(resultRef || null, current, current, jobId, workerId);
      if (!changed.changes) throw new Error('JOB_LEASE_LOST');
      return row(db, jobId);
    },
    fail(jobId, workerId, { code = 'FAILED', summary = null, retryable = false, now = new Date() } = {}) {
      const current = iso(now);
      const job = row(db, jobId);
      if (!job || job.status !== 'RUNNING' || job.lease_owner !== workerId) throw new Error('JOB_LEASE_LOST');
      const canRetry = retryable && job.attempts < job.max_attempts && job.cost_units < job.cost_limit;
      db.prepare(`UPDATE integration_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,
        completed_at=?,error_code=?,error_summary=?,updated_at=? WHERE job_id=? AND lease_owner=?`)
        .run(canRetry ? 'PENDING' : 'FAILED', canRetry ? null : current, code,
          String(summary || '').slice(0, 300) || null, current, jobId, workerId);
      return row(db, jobId);
    },
    cancel(jobId, now = new Date()) {
      const current = iso(now);
      db.prepare(`UPDATE integration_jobs SET status='CANCELLED',lease_owner=NULL,
        lease_expires_at=NULL,completed_at=?,updated_at=? WHERE job_id=? AND status IN ('PENDING','RUNNING')`)
        .run(current, current, jobId);
      return row(db, jobId);
    },
  });
}
