import { randomUUID } from 'node:crypto';
import { parseCandidateFact } from '../talent-contracts.js';

const STATUSES = new Set(['READY', 'NEEDS_REVIEW', 'OCR_REQUIRED', 'REJECTED']);

export async function persistCandidateDocument(conn, input, result, options = {}) {
  if (!STATUSES.has(result.status)) throw new Error('DOCUMENT_STATUS_INVALID');
  if (!/^[a-f0-9]{64}$/i.test(result.source_hash || '')) throw new Error('DOCUMENT_SOURCE_HASH_INVALID');
  const fact = result.status === 'READY' ? (options.validateFact || parseCandidateFact)(result.fact) : null;
  if (fact && (fact.document.content_hash !== result.source_hash
      || fact.document.document_ref !== input.documentRef || fact.document.source_format !== input.sourceFormat)) {
    throw new Error('DOCUMENT_FACT_SOURCE_MISMATCH');
  }
  const documentId = input.documentId || randomUUID();
  const at = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  await conn.beginTransaction();
  try {
    await conn.execute(`INSERT INTO candidate_documents
      (document_id,talent_id,source_system,source_document_ref,source_format,content_hash,
       parser_version,quality_status,ingested_at,processed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
       parser_version=VALUES(parser_version),quality_status=VALUES(quality_status),processed_at=VALUES(processed_at)`,
    [documentId, input.talentId, input.sourceSystem, input.documentRef, input.sourceFormat,
      result.source_hash, result.parser_version, result.status, at, at]);
    if (fact) {
      await conn.execute(`INSERT IGNORE INTO candidate_fact_versions
        (fact_version_id,tenant_id,talent_id,candidate_ref,document_id,schema_version,
         facts_json,evidence_coverage,quality_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [fact.fact_version_id, input.tenantId, input.talentId, fact.candidate_ref, documentId,
        fact.schema_version, JSON.stringify(fact), fact.quality.evidence_coverage, fact.quality.status, at]);
      for (const evidence of fact.evidence) await conn.execute(`INSERT IGNORE INTO candidate_fact_evidence
        (evidence_id,fact_version_id,field_path,source_ref,page_number,section_name,
         char_start,char_end,excerpt_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [evidence.evidence_ref, fact.fact_version_id, evidence.field_path, evidence.source_ref,
        evidence.page || null, evidence.section || null, evidence.char_start ?? null,
        evidence.char_end ?? null, evidence.excerpt_hash, at]);
    }
    await conn.commit();
    return { document_id: documentId, status: result.status, fact_version_id: fact?.fact_version_id || null };
  } catch (error) {
    await conn.rollback();
    throw error;
  }
}
