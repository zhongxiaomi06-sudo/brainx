/** job-source-contract.js — 来源 adapter 到 Canonical Job 的统一信封（specs/028）。 */
import { createHash } from 'node:crypto';

export const JOB_SOURCE_ENVELOPE_VERSION = 'job-source-envelope-v1';
export const CANONICAL_JOB_VERSION = 'canonical-job-v1';

const FACT_FIELDS = [
  'project_id', 'company', 'role', 'city', 'pipeline', 'hc', 'active_state',
  'priority', 'notes', 'company_type', 'owner_name', 'owner_unique_id', 'chat_id',
];

export function canonicalJob(row) {
  const out = {};
  for (const field of FACT_FIELDS) out[field] = row?.[field] ?? null;
  const cities = Array.isArray(row?.cities)
    ? row.cities.map((value) => String(value).trim()).filter(Boolean)
    : String(row?.city || '').split('、').map((value) => value.trim()).filter(Boolean);
  out.cities = cities.length ? [...new Set(cities)].sort() : null;
  return out;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
}

const requiredText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空字符串`);
  return value.trim();
};

export function createSourceEnvelope({
  sourceType,
  sourceInstanceId,
  adapterVersion,
  schemaVersion = CANONICAL_JOB_VERSION,
  batchId,
  scope = {},
  cursor = null,
  complete,
  receivedAt,
  records,
  tombstones = [],
  errors = [],
  asOf = null,
}) {
  if (typeof complete !== 'boolean') throw new TypeError('complete 必须是 boolean');
  if (!Array.isArray(records) || !Array.isArray(tombstones) || !Array.isArray(errors)) {
    throw new TypeError('records/tombstones/errors 必须是数组');
  }
  return {
    envelope_version: JOB_SOURCE_ENVELOPE_VERSION,
    source_type: requiredText(sourceType, 'sourceType'),
    source_instance_id: requiredText(sourceInstanceId, 'sourceInstanceId'),
    adapter_version: requiredText(adapterVersion, 'adapterVersion'),
    schema_version: requiredText(schemaVersion, 'schemaVersion'),
    batch_id: requiredText(batchId, 'batchId'),
    scope: scope && typeof scope === 'object' ? scope : {},
    cursor,
    complete,
    received_at: requiredText(receivedAt, 'receivedAt'),
    as_of: asOf || receivedAt,
    records,
    tombstones,
    errors: errors.map(String),
  };
}

export function normalizeSourcePayload(payload, { source, receivedAt }) {
  if (payload?.envelope_version === JOB_SOURCE_ENVELOPE_VERSION) return payload;
  const records = payload?.jobs;
  if (!Array.isArray(records)) throw new TypeError('来源 payload 必须包含 jobs 或统一来源信封');
  const at = payload.as_of || receivedAt;
  return createSourceEnvelope({
    sourceType: source,
    sourceInstanceId: `${source}:default`,
    adapterVersion: `${source}-legacy-v1`,
    batchId: `legacy:${sha256({ source, at, records: records.map(canonicalJob) }).slice(0, 24)}`,
    scope: { tenant_id: 'brainx' },
    complete: payload.complete !== false,
    cursor: payload.cursor ?? null,
    receivedAt: at,
    asOf: at,
    records,
    tombstones: payload.tombstones || [],
    errors: payload.errors || [],
  });
}

export function sourceRecordMeta(job, envelope) {
  const meta = job?.source_meta || {};
  return {
    tenantId: envelope.scope?.tenant_id || 'brainx',
    sourceType: envelope.source_type,
    sourceInstanceId: meta.source_instance_id || envelope.source_instance_id,
    externalId: String(meta.external_id || job.project_id),
    adapterVersion: meta.adapter_version || envelope.adapter_version,
    schemaVersion: meta.schema_version || envelope.schema_version,
    snapshotId: meta.source_snapshot_id || envelope.batch_id,
    observedAt: meta.observed_at || job.captured_at || envelope.as_of || envelope.received_at,
    evidence: meta.evidence || {},
    scope: envelope.scope,
  };
}
