/** Import existing reloop recommendations into the versioned, authorized shortlist spine. */
import { initTalentSchema, withMysql } from './db.js';
import {
  buildReloopCandidateFact,
  buildReloopMatchPayload,
  digest,
  normalizeReloopScore,
} from './reloop-shortlist-pipeline.js';

const ALGORITHM_VERSION = 'reloop-existing-recommendation-v1.2';
const id = (prefix, value) => `${prefix}_${digest(value).slice(0, 48)}`;
const json = (value, fallback = {}) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
};

function required(value, name, pattern = /^[\w:.-]{1,160}$/) {
  const normalized = String(value || '').trim();
  if (!pattern.test(normalized)) throw new Error(`INVALID_${name.toUpperCase()}`);
  return normalized;
}

async function loadSource(conn, sourceOwnerId, positionId, expectedBoundName, limit) {
  const [[owner]] = await conn.execute(
    `SELECT user_id, display_name, ttc_bound_name
     FROM reloop_app.users WHERE user_id = ? LIMIT 1`, [sourceOwnerId],
  );
  if (!owner || String(owner.ttc_bound_name || '').trim() !== expectedBoundName) {
    throw new Error('SOURCE_ACCOUNT_BINDING_MISMATCH');
  }
  const [[position]] = await conn.execute(
    `SELECT id, owner_user_id, position_name, jd_analysis, jd_analysis_version, created_at
     FROM reloop_app.positions WHERE id = ? AND owner_user_id = ? AND is_active = 1 LIMIT 1`,
    [positionId, sourceOwnerId],
  );
  if (!position) throw new Error('ACTIVE_SOURCE_POSITION_NOT_FOUND');
  const [[batch]] = await conn.execute(
    `SELECT run_id, recommend_date FROM reloop_app.recommendations
     WHERE owner_user_id = ? AND focus_position = ? AND status = 'pending'
     ORDER BY recommend_date DESC, created_at DESC, id DESC LIMIT 1`,
    [sourceOwnerId, position.position_name],
  );
  if (!batch) throw new Error('SOURCE_RECOMMENDATIONS_NOT_FOUND');
  const batchClause = batch.run_id ? 'r.run_id = ?' : 'r.run_id IS NULL AND r.recommend_date = ?';
  const batchValue = batch.run_id || batch.recommend_date;
  const [profiles] = await conn.execute(
    `SELECT r.id AS recommendation_id, r.run_id, r.rank AS source_rank, r.score,
            r.score_breakdown, r.recommend_date,
            t.id, t.name, t.base_location, t.company, t.position, t.work_years,
            t.education, t.skills, t.value_score, t.last_active_at, t.tags,
            t.source_payload, t.work_history, t.education_history,
            t.expected_salary, t.updated_at
     FROM reloop_app.recommendations r
     JOIN reloop_app.talent_profiles t
       ON t.id = r.talent_id AND t.owner_user_id = r.owner_user_id
     WHERE r.owner_user_id = ? AND r.focus_position = ? AND r.status = 'pending'
       AND ${batchClause}
     ORDER BY r.rank ASC, r.id ASC LIMIT ${limit}`,
    [sourceOwnerId, position.position_name, batchValue],
  );
  return { owner, position, profiles, batch };
}

function prepare(source, processedAt) {
  const criteria = json(source.position.jd_analysis, {});
  const entries = source.profiles.map((profile) => {
    const fact = buildReloopCandidateFact(profile, { processedAt });
    const payload = buildReloopMatchPayload(profile, profile, criteria, fact);
    return { profile, fact, payload };
  }).filter(({ fact }) => fact.quality.status === 'READY');
  const externalJobRef = `reloop-position:${source.position.id}`;
  const sourceHash = digest({ position_id: source.position.id, criteria,
    version: source.position.jd_analysis_version, created_at: source.position.created_at });
  const jobVersionId = id('rjob', { externalJobRef, sourceHash });
  const matchRunId = id('rrun', { jobVersionId, source_run: source.batch.run_id,
    source_date: source.batch.recommend_date, algorithm_version: ALGORITHM_VERSION,
    facts: entries.map(({ fact }) => fact.fact_version_id) });
  return { criteria, entries, externalJobRef, sourceHash, jobVersionId, matchRunId };
}

async function ensureShadowTalent(conn, tenantId, entry, createdAt) {
  const candidateRef = entry.fact.candidate_ref;
  const [[linked]] = await conn.execute(
    `SELECT talent_id FROM candidate_source_links
     WHERE tenant_id = ? AND source_system = 'reloop_app' AND source_candidate_ref = ?`,
    [tenantId, candidateRef],
  );
  if (linked) return Number(linked.talent_id);
  const profile = entry.profile;
  const [inserted] = await conn.execute(
    `INSERT INTO talent (name, phone, email, status, last_active_time, summary, created_by)
     VALUES (?, NULL, NULL, 'active', ?, ?, NULL)`,
    [entry.fact.identity.display_name, profile.last_active_at || null,
      [profile.company, profile.position].filter(Boolean).join(' / ').slice(0, 1_000) || null],
  );
  const talentId = Number(inserted.insertId);
  await conn.execute(
    `INSERT INTO candidate_source_links
       (tenant_id, source_system, source_candidate_ref, talent_id, created_at)
     VALUES (?, 'reloop_app', ?, ?, ?)`, [tenantId, candidateRef, talentId, createdAt],
  );
  return talentId;
}

async function writeFact(conn, tenantId, sourceOwnerId, consultantId, entry, createdAt) {
  const talentId = await ensureShadowTalent(conn, tenantId, entry, createdAt);
  const { fact } = entry;
  const documentId = id('rdoc', { talentId, hash: fact.document.content_hash });
  await conn.execute(
    `INSERT IGNORE INTO candidate_documents
       (document_id, talent_id, source_system, source_document_ref, source_format,
        content_hash, parser_version, quality_status, ingested_at, processed_at)
     VALUES (?, ?, 'reloop_app', ?, 'legacy_text', ?, ?, ?, ?, ?)`,
    [documentId, talentId, fact.document.document_ref, fact.document.content_hash,
      fact.document.parser_version, fact.quality.status, createdAt, new Date(fact.document.processed_at)],
  );
  await conn.execute(
    `INSERT IGNORE INTO candidate_fact_versions
       (fact_version_id, tenant_id, talent_id, candidate_ref, document_id, schema_version,
        facts_json, evidence_coverage, quality_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [fact.fact_version_id, tenantId, talentId, fact.candidate_ref, documentId,
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
  const grantId = id('tgrant', { tenantId, talentId, consultantId, purpose: 'candidate_review' });
  await conn.execute(
    `INSERT IGNORE INTO talent_access_grants
       (grant_id, tenant_id, talent_id, source_system, source_account_ref,
        grantor_consultant_id, grantee_type, grantee_ref, scope, purpose, status,
        granted_at, source_proof_ref)
     VALUES (?, ?, ?, 'reloop_app', ?, ?, 'consultant', ?, 'resume_facts',
       'candidate_review', 'ACTIVE', ?, ?)`,
    [grantId, tenantId, talentId, sourceOwnerId, consultantId, consultantId, createdAt,
      `reloop_app.users:${sourceOwnerId}:ttc_bound_name`],
  );
  return talentId;
}

async function writePrepared(conn, input, prepared, createdAt) {
  const { tenantId, consultantId, sourceOwnerId } = input;
  const p = prepared;
  await conn.execute(
    `INSERT IGNORE INTO job_criteria_versions
       (job_version_id, tenant_id, external_job_ref, position_id, schema_version,
        criteria_json, source_hash, created_at)
     VALUES (?, ?, ?, NULL, 'reloop-jd-analysis-v1', ?, ?, ?)`,
    [p.jobVersionId, tenantId, p.externalJobRef, JSON.stringify(p.criteria), p.sourceHash, createdAt],
  );
  await conn.execute(
    `INSERT IGNORE INTO job_access_grants
       (grant_id, tenant_id, external_job_ref, source_system, source_account_ref,
        grantor_consultant_id, grantee_type, grantee_ref, purpose, status,
        granted_at, source_proof_ref)
     VALUES (?, ?, ?, 'reloop_app', ?, ?, 'consultant', ?, 'candidate_review',
       'ACTIVE', ?, ?)`,
    [id('jgrant', { tenantId, job: p.externalJobRef, consultantId }), tenantId,
      p.externalJobRef, sourceOwnerId, consultantId, consultantId, createdAt,
      `reloop_app.users:${sourceOwnerId}:ttc_bound_name`],
  );
  await conn.execute(
    `INSERT IGNORE INTO match_runs
       (match_run_id, tenant_id, job_version_id, algorithm_version, feature_schema_version,
        status, candidate_count, started_at, completed_at)
     VALUES (?, ?, ?, ?, 'candidate_fact_v1',
       'RUNNING', 0, ?, NULL)`,
    [p.matchRunId, tenantId, p.jobVersionId, ALGORITHM_VERSION, createdAt],
  );
  let rank = 0;
  for (const entry of p.entries) {
    const talentId = await writeFact(conn, tenantId, sourceOwnerId, consultantId, entry, createdAt);
    rank += 1;
    const hard = entry.payload.hard_conditions;
    const hardResult = hard.some((item) => item.result === 'FAIL') ? 'FAIL'
      : hard.some((item) => item.result === 'UNKNOWN') ? 'UNKNOWN' : 'PASS';
    await conn.execute(
      `INSERT IGNORE INTO candidate_job_matches
         (match_run_id, talent_id, fact_version_id, \`rank\`, strength_score,
          job_fit_score, hard_filter_result, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.matchRunId, talentId, entry.fact.fact_version_id, rank,
        normalizeReloopScore(entry.profile.value_score), normalizeReloopScore(entry.profile.score),
        hardResult, JSON.stringify(entry.payload), createdAt],
    );
  }
  await conn.execute(
    `UPDATE match_runs SET status = 'SUCCEEDED', candidate_count = ?, completed_at = ?
     WHERE match_run_id = ?`, [rank, createdAt, p.matchRunId],
  );
  return rank;
}

export async function syncReloopShortlist(rawInput, dependencies = {}) {
  const rawLimit = Number(rawInput.limit || 10);
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 20) throw new Error('INVALID_LIMIT');
  const input = {
    tenantId: required(rawInput.tenantId, 'tenant_id'),
    consultantId: required(rawInput.consultantId, 'consultant_id'),
    sourceOwnerId: required(rawInput.sourceOwnerId, 'source_owner_id'),
    expectedBoundName: required(rawInput.expectedBoundName, 'expected_bound_name', /^.{1,128}$/u),
    positionId: Number(rawInput.positionId),
    limit: rawLimit,
    dryRun: rawInput.dryRun !== false,
  };
  if (!Number.isSafeInteger(input.positionId) || input.positionId < 1) throw new Error('INVALID_POSITION_ID');
  const connect = dependencies.withConnection || withMysql;
  if (!dependencies.withConnection) await initTalentSchema();
  return connect(async (conn) => {
    const source = await loadSource(conn, input.sourceOwnerId, input.positionId,
      input.expectedBoundName, input.limit);
    const createdAt = new Date();
    const prepared = prepare(source, createdAt);
    const summary = { dry_run: input.dryRun, source_candidates: source.profiles.length,
      ready_candidates: prepared.entries.length, external_job_ref: prepared.externalJobRef,
      match_run_id: prepared.matchRunId };
    if (input.dryRun) return summary;
    await conn.beginTransaction();
    try {
      const written = await writePrepared(conn, input, prepared, createdAt);
      await conn.commit();
      return { ...summary, dry_run: false, written_candidates: written };
    } catch (error) {
      await conn.rollback();
      throw error;
    }
  });
}
