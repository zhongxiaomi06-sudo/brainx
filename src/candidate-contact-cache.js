/** 使用已有授权上下文表的加密字段保存 30 天成功快照；不让明文进入日志/群投影。 */
import { createHash, randomUUID } from 'node:crypto';
import { enc, dec } from './feishu.js';

const SOURCE = 'candidate_contact_cache';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const scope = (principal) => hash(`${principal.tenantId}\0${principal.consultantId}\0contact`);

export function readCandidateContactCache(db, principal, candidateRef, at = new Date()) {
  const row = db.prepare(`SELECT content_json FROM context_registry_entries
    WHERE tenant_id=? AND source_type=? AND source_id=? AND scope_hash=?
      AND revoked_at IS NULL AND expires_at>?
    ORDER BY created_at DESC LIMIT 1`).get(principal.tenantId, SOURCE, candidateRef,
    scope(principal), at.toISOString());
  if (!row) return null;
  try {
    const value = JSON.parse(dec(row.content_json));
    return value?.source === 'ttc_resume' && (value.phone || value.email) ? value : null;
  } catch { return null; }
}

export function saveCandidateContactCache(db, principal, candidateRef, value, at = new Date()) {
  if (!value || (!value.phone && !value.email) || value.source !== 'ttc_resume') {
    throw new Error('CANDIDATE_CONTACT_CACHE_INVALID');
  }
  const encrypted = enc(JSON.stringify({ phone: value.phone || null,
    email: value.email || null, source: value.source, attachmentId: value.attachmentId || null,
    capturedAt: at.toISOString() }));
  const expiry = new Date(at.getTime() + 30 * 24 * 3600_000).toISOString();
  const stale = db.prepare(`SELECT context_id FROM context_registry_entries
    WHERE tenant_id=? AND source_type=? AND source_id=? AND scope_hash=? AND revoked_at IS NULL`)
    .all(principal.tenantId, SOURCE, candidateRef, scope(principal));
  db.exec('SAVEPOINT candidate_contact_cache');
  try {
    db.prepare(`UPDATE context_registry_entries SET revoked_at=?,revoke_reason='refreshed'
      WHERE context_id=?`).run(at.toISOString(), stale[0]?.context_id || '');
    for (const row of stale.slice(1)) db.prepare(`UPDATE context_registry_entries
      SET revoked_at=?,revoke_reason='refreshed' WHERE context_id=?`)
      .run(at.toISOString(), row.context_id);
    db.prepare(`INSERT INTO context_registry_entries
      (context_id,tenant_id,source_type,source_id,source_version,scope_hash,summary,
       content_json,content_hash,size_bytes,expires_at,truncated,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`ctx_${randomUUID()}`, principal.tenantId,
      SOURCE, candidateRef, at.toISOString(), scope(principal), '本人授权简历联系快照',
      encrypted, hash(encrypted), Buffer.byteLength(encrypted), expiry, 0, at.toISOString());
    db.exec('RELEASE candidate_contact_cache');
  } catch (error) { db.exec('ROLLBACK TO candidate_contact_cache; RELEASE candidate_contact_cache'); throw error; }
}
