import { buildReloopCandidateFact, digest } from '../reloop-shortlist-pipeline.js';

const stableId = (prefix, value) => `${prefix}_${digest(value).slice(0, 48)}`;

async function resolveTalent(conn, input, fact, profile, createdAt) {
  const [[linked]] = await conn.execute(
    `SELECT talent_id FROM candidate_source_links
     WHERE tenant_id=? AND source_system='reloop_app' AND source_candidate_ref=? LIMIT 1`,
    [input.tenantId, fact.candidate_ref],
  );
  if (linked) return Number(linked.talent_id);
  const [inserted] = await conn.execute(
    `INSERT INTO talent (name, phone, email, status, last_active_time, summary, created_by)
     VALUES (?, NULL, NULL, 'active', ?, ?, NULL)`,
    [fact.identity.display_name, profile.last_active_at || null,
      [profile.company, profile.position].filter(Boolean).join(' / ').slice(0, 1_000) || null],
  );
  const talentId = Number(inserted.insertId);
  await conn.execute(
    `INSERT INTO candidate_source_links
       (tenant_id, source_system, source_candidate_ref, talent_id, created_at)
     VALUES (?, 'reloop_app', ?, ?, ?)`,
    [input.tenantId, fact.candidate_ref, talentId, createdAt],
  );
  return talentId;
}

async function writeOne(conn, input, profile, createdAt) {
  const fact = buildReloopCandidateFact(profile, { processedAt: createdAt.toISOString() });
  const talentId = await resolveTalent(conn, input, fact, profile, createdAt);
  const documentId = stableId('rdoc', { talentId, hash: fact.document.content_hash });
  await conn.execute(
    `INSERT IGNORE INTO candidate_documents
       (document_id, talent_id, source_system, source_document_ref, source_format,
        content_hash, parser_version, quality_status, ingested_at, processed_at)
     VALUES (?, ?, 'reloop_app', ?, 'legacy_text', ?, ?, ?, ?, ?)`,
    [documentId, talentId, fact.document.document_ref, fact.document.content_hash,
      fact.document.parser_version, fact.quality.status, createdAt, createdAt],
  );
  await conn.execute(
    `INSERT IGNORE INTO candidate_fact_versions
       (fact_version_id, tenant_id, talent_id, candidate_ref, document_id, schema_version,
        facts_json, evidence_coverage, quality_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fact.fact_version_id, input.tenantId, talentId, fact.candidate_ref, documentId,
      fact.schema_version, JSON.stringify(fact), fact.quality.evidence_coverage,
      fact.quality.status, createdAt],
  );
  for (const evidence of fact.evidence) {
    await conn.execute(
      `INSERT IGNORE INTO candidate_fact_evidence
         (evidence_id, fact_version_id, field_path, source_ref, page_number, section_name,
          char_start, char_end, excerpt_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [evidence.evidence_ref, fact.fact_version_id, evidence.field_path, evidence.source_ref,
        evidence.page || null, evidence.section || null, evidence.char_start ?? null,
        evidence.char_end ?? null, evidence.excerpt_hash, createdAt],
    );
  }
  await conn.execute(
    `INSERT IGNORE INTO talent_access_grants
       (grant_id, tenant_id, talent_id, source_system, source_account_ref,
        grantor_consultant_id, grantee_type, grantee_ref, scope, purpose, status,
        granted_at, source_proof_ref)
     VALUES (?, ?, ?, 'reloop_app', ?, ?, 'consultant', ?, 'resume_facts',
       'candidate_review', 'ACTIVE', ?, ?)`,
    [stableId('tgrant', { tenantId: input.tenantId, talentId, consultantId: input.consultantId }),
      input.tenantId, talentId, input.sourceAccountRef, input.consultantId,
      input.consultantId, createdAt, input.sourceProofRef],
  );
  return { candidate_ref: fact.candidate_ref, fact_version_id: fact.fact_version_id, quality: fact.quality.status };
}

export async function writeStructuredCandidateFacts(conn, input) {
  if (!Array.isArray(input.profiles) || input.profiles.length > 500) throw new Error('PROFILES_INVALID');
  const createdAt = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const results = [];
  for (const profile of input.profiles) results.push(await writeOne(conn, input, profile, createdAt));
  return results;
}
