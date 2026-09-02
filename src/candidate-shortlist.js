/** Read-only, fail-closed projection of precomputed candidate matches. */
import { withMysql } from './db.js';
import {
  CANDIDATE_MATCH_BUNDLE_SCHEMA_VERSION,
  parseCandidateMatchBundle,
  parseStoredCandidateMatchPayload,
} from './talent-contracts.js';

const MAX_LIMIT = 20;
const PURPOSES = new Set(['candidate_review', 'interview_prep', 'daily_brief']);

const SELECT = `SELECT
  mr.match_run_id, mr.algorithm_version, mr.feature_schema_version, mr.completed_at,
  cfv.candidate_ref, t.name AS candidate_name, cjm.\`rank\` AS match_rank,
  cjm.strength_score, cjm.job_fit_score, cjm.hard_filter_result,
  cjm.payload_json, cd.processed_at AS fact_processed_at
FROM match_runs mr
JOIN job_criteria_versions jcv ON jcv.job_version_id = mr.job_version_id
JOIN candidate_job_matches cjm ON cjm.match_run_id = mr.match_run_id
JOIN candidate_fact_versions cfv ON cfv.fact_version_id = cjm.fact_version_id
JOIN candidate_documents cd ON cd.document_id = cfv.document_id
JOIN talent t ON t.id = cjm.talent_id`;

const AUTHORIZED = `EXISTS (
  SELECT 1 FROM talent_access_grants tag
  WHERE tag.tenant_id = mr.tenant_id
    AND tag.talent_id = cjm.talent_id
    AND tag.status = 'ACTIVE'
    AND tag.scope = 'resume_facts'
    AND tag.purpose = ?
    AND tag.granted_at <= UTC_TIMESTAMP(3)
    AND (tag.expires_at IS NULL OR tag.expires_at > UTC_TIMESTAMP(3))
    AND (tag.revoked_at IS NULL OR tag.revoked_at > UTC_TIMESTAMP(3))
    AND (
      (tag.grantee_type = 'consultant' AND tag.grantee_ref = ?)
      OR (tag.grantee_type = 'project' AND tag.grantee_ref = ?)
    )
)`;

const LATEST_RUN = `mr.match_run_id = (
  SELECT mr2.match_run_id
  FROM match_runs mr2
  JOIN job_criteria_versions jcv2 ON jcv2.job_version_id = mr2.job_version_id
  WHERE mr2.tenant_id = ?
    AND jcv2.external_job_ref = ?
    AND mr2.status = 'SUCCEEDED'
    AND mr2.completed_at IS NOT NULL
  ORDER BY mr2.completed_at DESC, mr2.match_run_id DESC
  LIMIT 1
)`;

function inputError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENT';
  return error;
}

function qualityError() {
  const error = new Error('stored candidate match does not satisfy candidate_match_bundle_v1');
  error.code = 'QUALITY_INSUFFICIENT';
  return error;
}

function sourceError() {
  const error = new Error('talent source is unavailable');
  error.code = 'SOURCE_UNAVAILABLE';
  return error;
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw qualityError();
  return date.toISOString();
}

function parseJson(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(String(value)); } catch { throw qualityError(); }
}

export function maskCandidateName(value) {
  const chars = Array.from(String(value || '').trim());
  return chars.length ? `${chars[0]}*` : '候*';
}

export function encodeShortlistPageToken(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeShortlistPageToken(token) {
  try {
    const value = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    if (value?.version !== 1 || typeof value.match_run_id !== 'string' || !value.match_run_id
      || !Number.isInteger(value.after_rank) || value.after_rank < 1) throw new Error('invalid');
    return { version: 1, match_run_id: value.match_run_id, after_rank: value.after_rank };
  } catch {
    throw inputError('invalid page_token');
  }
}

function normalizeInput(input) {
  const tenantId = String(input?.tenantId || '').trim();
  const consultantId = String(input?.consultantId || '').trim();
  const jobId = String(input?.jobId || '').trim();
  const purpose = String(input?.purpose || 'candidate_review').trim();
  const limit = input?.limit === undefined ? 5 : Number(input.limit);
  if (!tenantId) throw inputError('tenant_id required');
  if (!consultantId) throw inputError('consultant_id required');
  if (!jobId) throw inputError('job_id required');
  if (!PURPOSES.has(purpose)) throw inputError('unsupported purpose');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw inputError('limit must be 1..20');
  const cursor = input?.pageToken ? decodeShortlistPageToken(input.pageToken) : null;
  return { tenantId, consultantId, jobId, purpose, limit, cursor };
}

function queryFor(input) {
  const common = `
WHERE mr.tenant_id = ?
  AND jcv.external_job_ref = ?
  AND mr.status = 'SUCCEEDED'
  AND mr.completed_at IS NOT NULL
  AND cfv.quality_status = 'READY'
  AND cjm.\`rank\` > ?
  AND ${AUTHORIZED}`;
  if (input.cursor) {
    return {
      sql: `${SELECT}${common}
  AND mr.match_run_id = ?
ORDER BY cjm.\`rank\` ASC
LIMIT ?`,
      params: [input.tenantId, input.jobId, input.cursor.after_rank,
        input.purpose, input.consultantId, input.jobId, input.cursor.match_run_id, input.limit],
    };
  }
  return {
    sql: `${SELECT}${common}
  AND ${LATEST_RUN}
ORDER BY cjm.\`rank\` ASC
LIMIT ?`,
    params: [input.tenantId, input.jobId, 0, input.purpose, input.consultantId, input.jobId,
      input.tenantId, input.jobId, input.limit],
  };
}

function itemFromRow(row) {
  let payload;
  try { payload = parseStoredCandidateMatchPayload(parseJson(row.payload_json)); }
  catch { throw qualityError(); }
  return {
    candidate_ref: String(row.candidate_ref),
    display_name_masked: maskCandidateName(row.candidate_name),
    rank: Number(row.match_rank),
    strength: { score: Number(row.strength_score), summary: payload.strength_summary,
      evidence_refs: payload.strength_evidence_refs },
    job_fit: { score: Number(row.job_fit_score), summary: payload.job_fit_summary,
      evidence_refs: payload.job_fit_evidence_refs },
    hard_conditions: payload.hard_conditions,
    gaps: payload.gaps,
    risks: payload.risks,
    unknowns: payload.unknowns,
    data_freshness: { fact_processed_at: iso(row.fact_processed_at), status: payload.freshness_status },
  };
}

/**
 * Reads only completed precomputed results. Authorization is part of the SQL so
 * non-existent, unauthorized and empty jobs share the same response shape.
 */
export async function candidateShortlist(rawInput, dependencies = {}) {
  const input = normalizeInput(rawInput);
  const { sql, params } = queryFor(input);
  const withConnection = dependencies.withConnection || withMysql;
  let rows;
  try {
    rows = await withConnection(async (conn) => {
      const [result] = await conn.execute(sql, params);
      return result;
    });
  } catch (error) {
    if (error?.code === 'QUALITY_INSUFFICIENT') throw error;
    throw sourceError();
  }

  const items = rows.map(itemFromRow);
  const first = rows[0];
  const matchRun = first ? {
    match_run_id: String(first.match_run_id),
    algorithm_version: String(first.algorithm_version),
    feature_schema_version: String(first.feature_schema_version),
    completed_at: iso(first.completed_at),
  } : null;
  const last = items.at(-1);
  const nextPageToken = items.length === input.limit && last && matchRun
    ? encodeShortlistPageToken({ version: 1, match_run_id: matchRun.match_run_id, after_rank: last.rank })
    : null;
  const bundle = {
    schema_version: CANDIDATE_MATCH_BUNDLE_SCHEMA_VERSION,
    job_ref: input.jobId,
    match_run: matchRun,
    page: { limit: input.limit, next_page_token: nextPageToken },
    items,
    data_scope: { scope: 'authorized_shortlist', purpose: input.purpose },
    generated_at: new Date().toISOString(),
    ...(items.length ? {} : { empty_reason: 'NO_AUTHORIZED_SHORTLIST' }),
  };
  try { return parseCandidateMatchBundle(bundle); } catch { throw qualityError(); }
}
