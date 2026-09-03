import { randomUUID } from 'node:crypto';

function required(value, code) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 160) throw new Error(code);
  return text;
}

export async function grantTalentAccess(conn, raw) {
  const input = {
    grantId: required(raw.grantId || randomUUID(), 'GRANT_ID_INVALID'),
    tenantId: required(raw.tenantId, 'TENANT_ID_INVALID'),
    talentId: Number(raw.talentId),
    sourceSystem: required(raw.sourceSystem, 'SOURCE_SYSTEM_INVALID'),
    sourceAccountRef: required(raw.sourceAccountRef, 'SOURCE_ACCOUNT_INVALID'),
    grantorConsultantId: required(raw.grantorConsultantId, 'GRANTOR_INVALID'),
    granteeRef: required(raw.granteeRef, 'GRANTEE_INVALID'),
    purpose: required(raw.purpose || 'candidate_review', 'PURPOSE_INVALID'),
    sourceProofRef: required(raw.sourceProofRef, 'SOURCE_PROOF_INVALID'),
  };
  if (!Number.isSafeInteger(input.talentId) || input.talentId < 1) throw new Error('TALENT_ID_INVALID');
  await conn.execute(
    `INSERT INTO talent_access_grants
       (grant_id,tenant_id,talent_id,source_system,source_account_ref,
        grantor_consultant_id,grantee_type,grantee_ref,scope,purpose,status,
        granted_at,source_proof_ref)
     VALUES (?,?,?,?,?,?,'consultant',?,'resume_facts',?,'ACTIVE',UTC_TIMESTAMP(3),?)`,
    [input.grantId, input.tenantId, input.talentId, input.sourceSystem,
      input.sourceAccountRef, input.grantorConsultantId, input.granteeRef,
      input.purpose, input.sourceProofRef],
  );
  return { grant_id: input.grantId, status: 'ACTIVE' };
}

function cancelPendingNotifications(db, input, updatedAt) {
  if (!db) return 0;
  const result = db.prepare(`UPDATE integration_outbox
    SET status='CANCELLED', updated_at=?, last_error_code='ACCESS_REVOKED'
    WHERE status IN ('PENDING','FAILED') AND job_id IN (
      SELECT job_id FROM integration_jobs
      WHERE tenant_id=? AND (
        json_extract(payload_json,'$.talent_id')=?
        OR json_extract(payload_json,'$.candidate_ref')=?
      )
    )`).run(updatedAt, input.tenantId, input.talentId, input.candidateRef);
  return result.changes;
}

export async function revokeTalentAccess(raw) {
  const input = {
    tenantId: required(raw.tenantId, 'TENANT_ID_INVALID'),
    talentId: Number(raw.talentId),
    sourceAccountRef: required(raw.sourceAccountRef, 'SOURCE_ACCOUNT_INVALID'),
    candidateRef: required(raw.candidateRef, 'CANDIDATE_REF_INVALID'),
  };
  if (!Number.isSafeInteger(input.talentId) || input.talentId < 1) throw new Error('TALENT_ID_INVALID');
  const revokedAt = raw.revokedAt instanceof Date ? raw.revokedAt : new Date(raw.revokedAt || Date.now());
  if (Number.isNaN(revokedAt.getTime())) throw new Error('REVOKED_AT_INVALID');
  await raw.conn.beginTransaction();
  let result;
  try {
    [result] = await raw.conn.execute(
      `UPDATE talent_access_grants SET status='REVOKED', revoked_at=?
       WHERE tenant_id=? AND talent_id=? AND source_account_ref=? AND status='ACTIVE'`,
      [revokedAt, input.tenantId, input.talentId, input.sourceAccountRef],
    );
    await raw.conn.commit();
  } catch (error) {
    await raw.conn.rollback();
    throw error;
  }
  const cancelled = cancelPendingNotifications(raw.db, input, revokedAt.toISOString());
  const invalidations = [raw.cache?.deleteCandidate, raw.index?.deleteCandidate]
    .filter(item => typeof item === 'function')
    .map(fn => fn(input.candidateRef));
  const settled = await Promise.allSettled(invalidations);
  if (settled.some(item => item.status === 'rejected')) throw new Error('REVOCATION_PROPAGATION_FAILED');
  return { revoked_grants: Number(result.affectedRows || 0), cancelled_notifications: cancelled };
}
