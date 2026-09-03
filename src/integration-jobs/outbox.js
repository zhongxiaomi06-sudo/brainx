import { randomUUID } from 'node:crypto';

const iso = value => (value instanceof Date ? value : new Date(value || Date.now())).toISOString();

function get(db, id) {
  return db.prepare('SELECT * FROM integration_outbox WHERE outbox_id=?').get(id) || null;
}

export function createOutbox(db) {
  return Object.freeze({
    enqueue(input) {
      const existing = db.prepare('SELECT * FROM integration_outbox WHERE job_id=? AND payload_ref=?')
        .get(input.jobId, input.payloadRef);
      if (existing) return existing;
      const now = iso(input.now);
      const outboxId = input.outboxId || randomUUID();
      db.prepare(`INSERT INTO integration_outbox
        (outbox_id,job_id,channel,account_id,target_hash,thread_id_hash,payload_ref,
         status,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'PENDING',0,?,?,?)`).run(
        outboxId, input.jobId, input.channel, input.accountId, input.targetHash,
        input.threadIdHash || null, input.payloadRef, now, now, now,
      );
      return get(db, outboxId);
    },
    async deliverNext({ authorize, send, now = new Date() }) {
      const current = iso(now);
      db.exec('BEGIN IMMEDIATE');
      let item;
      try {
        const pending = db.prepare(`SELECT * FROM integration_outbox
          WHERE status IN ('PENDING','FAILED') AND next_attempt_at<=?
          ORDER BY created_at,outbox_id LIMIT 1`).get(current);
        if (!pending) {
          db.exec('COMMIT');
          return null;
        }
        db.prepare("UPDATE integration_outbox SET status='SENDING',attempts=attempts+1,updated_at=? WHERE outbox_id=?")
          .run(current, pending.outbox_id);
        item = get(db, pending.outbox_id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      if (!item) return null;
      if (!(await authorize(item))) {
        db.prepare("UPDATE integration_outbox SET status='CANCELLED',last_error_code='ACCESS_REVOKED',updated_at=? WHERE outbox_id=?")
          .run(current, item.outbox_id);
        return get(db, item.outbox_id);
      }
      try {
        await send(item);
        db.prepare("UPDATE integration_outbox SET status='SENT',sent_at=?,updated_at=? WHERE outbox_id=?")
          .run(current, current, item.outbox_id);
      } catch {
        const retryAt = new Date(new Date(current).getTime() + Math.min(300_000, 2 ** item.attempts * 1_000)).toISOString();
        db.prepare("UPDATE integration_outbox SET status='FAILED',next_attempt_at=?,last_error_code='DELIVERY_FAILED',updated_at=? WHERE outbox_id=?")
          .run(retryAt, current, item.outbox_id);
      }
      return get(db, item.outbox_id);
    },
  });
}
