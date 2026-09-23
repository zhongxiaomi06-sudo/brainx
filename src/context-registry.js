/** 授权上下文注册表：每次读取重新验证租户、作用域、有效期与撤权。 */
import { now, uuid } from './db.js';
import { sha256, stableJson } from './job-source-contract.js';

function validIso(value, field) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${field} 必须是有效 ISO 时间`);
  return new Date(ms).toISOString();
}

function scopeHash(input) {
  if (!input.tenantId || !input.consultantId || !input.purpose) {
    throw new TypeError('上下文作用域缺 tenantId、consultantId 或 purpose');
  }
  return sha256({
    tenant_id: String(input.tenantId),
    consultant_id: String(input.consultantId),
    purpose: String(input.purpose),
    project_ids: [...new Set((input.projectIds || []).map(String))].sort(),
  });
}

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function registerContext(db, input) {
  for (const field of ['sourceType', 'sourceId', 'sourceVersion']) {
    if (!String(input[field] || '').trim()) throw new TypeError(`${field} 不能为空`);
  }
  const expiresAt = validIso(input.expiresAt, 'expiresAt');
  if (Date.parse(expiresAt) <= Date.now()) throw new TypeError('expiresAt 必须晚于当前时间');
  const contentJson = stableJson(input.content ?? null);
  const authorization = scopeHash(input);
  const contentHash = sha256(contentJson);
  const prior = db.prepare(`SELECT context_id FROM context_registry_entries
    WHERE tenant_id=? AND source_type=? AND source_id=? AND source_version=?
      AND scope_hash=? AND content_hash=? AND revoked_at IS NULL AND expires_at>?
    ORDER BY created_at DESC LIMIT 1`).get(
    input.tenantId, input.sourceType, input.sourceId, input.sourceVersion,
    authorization, contentHash, now(),
  );
  if (prior) return { context_id: prior.context_id, created: false };
  const contextId = `ctx_${uuid()}`;
  db.prepare(`INSERT INTO context_registry_entries
    (context_id, tenant_id, source_type, source_id, source_version, scope_hash,
     summary, content_json, content_hash, size_bytes, expires_at, truncated, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    contextId, input.tenantId, input.sourceType, input.sourceId, input.sourceVersion,
    authorization, String(input.summary || '').slice(0, 2000), contentJson, contentHash,
    Buffer.byteLength(contentJson), expiresAt, input.truncated ? 1 : 0, now(),
  );
  return { context_id: contextId, created: true };
}

export function readContext(db, input) {
  const row = db.prepare('SELECT * FROM context_registry_entries WHERE context_id=?')
    .get(input.contextId);
  if (!row || row.tenant_id !== input.tenantId || row.scope_hash !== scopeHash(input)) {
    throw contextError('CONTEXT_NOT_AUTHORIZED');
  }
  if (row.revoked_at) throw contextError('CONTEXT_REVOKED');
  const at = validIso(input.at || now(), 'at');
  if (Date.parse(row.expires_at) <= Date.parse(at)) throw contextError('CONTEXT_EXPIRED');
  let content;
  try { content = JSON.parse(row.content_json); } catch { throw contextError('CONTEXT_CORRUPT'); }
  return {
    context_id: row.context_id, source_type: row.source_type, source_id: row.source_id,
    source_version: row.source_version, summary: row.summary, content,
    content_hash: row.content_hash, size_bytes: row.size_bytes,
    expires_at: row.expires_at, truncated: !!row.truncated,
  };
}

export function revokeContext(db, { contextId, tenantId, reason = 'revoked', at = now() }) {
  const result = db.prepare(`UPDATE context_registry_entries
    SET revoked_at=?, revoke_reason=? WHERE context_id=? AND tenant_id=? AND revoked_at IS NULL`)
    .run(at, String(reason).slice(0, 120), contextId, tenantId);
  return { revoked: result.changes === 1 };
}

export function linkRunContext(db, { runId, contextId, accessedAt = now() }) {
  db.prepare(`INSERT OR IGNORE INTO agent_run_context_refs (run_id, context_id, accessed_at)
    VALUES (?,?,?)`).run(runId, contextId, accessedAt);
}
