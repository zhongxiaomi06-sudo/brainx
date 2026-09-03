import { createHmac } from 'node:crypto';

export class AgentRateLimitError extends Error {
  constructor(retryAfter) {
    super('RATE_LIMITED');
    this.name = 'AgentRateLimitError';
    this.code = 'RATE_LIMITED';
    this.retryAfter = retryAfter;
  }
}

function bucketKey(principal, toolName, auditKey) {
  const key = Buffer.from(String(auditKey || ''), 'utf8');
  if (key.length < 32) throw Object.assign(new Error('RATE_LIMIT_KEY_INVALID'), { code: 'INTERNAL' });
  const identity = `${principal.tenantId}\0${principal.consultantId}\0${toolName}`;
  return createHmac('sha256', key).update(identity, 'utf8').digest('hex');
}

export function consumeRateLimit(db, principal, toolName, options = {}) {
  const limit = options.limit ?? 20;
  const windowSeconds = options.windowSeconds ?? 60;
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw Object.assign(new Error('RATE_LIMIT_CONFIG_INVALID'), { code: 'INTERNAL' });
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const windowMs = windowSeconds * 1000;
  const windowStartMs = Math.floor(now.getTime() / windowMs) * windowMs;
  const windowStartedAt = new Date(windowStartMs).toISOString();
  const key = bucketKey(principal, toolName, options.auditKey);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = db.prepare('SELECT window_started_at, request_count FROM agent_rate_limits WHERE bucket_key=?')
      .get(key);
    let count;
    if (!current || current.window_started_at !== windowStartedAt) {
      count = 1;
      db.prepare(`INSERT INTO agent_rate_limits (bucket_key, window_started_at, request_count, updated_at)
        VALUES (?, ?, 1, ?)
        ON CONFLICT(bucket_key) DO UPDATE SET window_started_at=excluded.window_started_at,
          request_count=1, updated_at=excluded.updated_at`).run(key, windowStartedAt, now.toISOString());
    } else if (current.request_count >= limit) {
      const retryAfter = Math.max(1, Math.ceil((windowStartMs + windowMs - now.getTime()) / 1000));
      throw new AgentRateLimitError(retryAfter);
    } else {
      count = current.request_count + 1;
      db.prepare(`UPDATE agent_rate_limits SET request_count=?, updated_at=? WHERE bucket_key=?`)
        .run(count, now.toISOString(), key);
    }
    db.exec('COMMIT');
    return { remaining: limit - count, resetAt: new Date(windowStartMs + windowMs).toISOString() };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
