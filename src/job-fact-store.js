/** job-fact-store.js — job_facts 当前投影的唯一写模块与不可变版本账本（specs/028）。 */
import { now } from './db.js';
import { canonicalJob, sha256, sourceRecordMeta, stableJson } from './job-source-contract.js';

const PROJECTION_FIELDS = [
  'company', 'role', 'city', 'pipeline', 'hc', 'active_state', 'priority', 'notes',
  'company_type', 'owner_name', 'owner_unique_id', 'chat_id',
];

const SOURCE_UPSERT = `INSERT INTO job_facts
  (project_id, company, role, city, pipeline, hc, active_state, priority, notes,
   company_type, owner_name, owner_unique_id, chat_id, source_url, captured_at,
   sync_id, raw_json, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(project_id) DO UPDATE SET
    company=excluded.company, role=excluded.role, city=excluded.city,
    pipeline=excluded.pipeline, hc=excluded.hc, active_state=excluded.active_state,
    priority=excluded.priority, notes=excluded.notes, company_type=excluded.company_type,
    owner_name=excluded.owner_name, owner_unique_id=excluded.owner_unique_id,
    chat_id=excluded.chat_id, source_url=excluded.source_url,
    captured_at=CASE WHEN
      job_facts.company IS NOT excluded.company OR job_facts.role IS NOT excluded.role OR
      job_facts.city IS NOT excluded.city OR job_facts.pipeline IS NOT excluded.pipeline OR
      job_facts.hc IS NOT excluded.hc OR job_facts.active_state IS NOT excluded.active_state OR
      job_facts.priority IS NOT excluded.priority OR job_facts.notes IS NOT excluded.notes OR
      job_facts.company_type IS NOT excluded.company_type OR
      job_facts.owner_name IS NOT excluded.owner_name OR job_facts.chat_id IS NOT excluded.chat_id
      THEN excluded.captured_at ELSE job_facts.captured_at END,
    sync_id=excluded.sync_id, raw_json=excluded.raw_json, updated_at=excluded.updated_at`;

function upsertProjection(db, { job, syncId, asOf, rawJson = null }) {
  const storedJson = rawJson ?? JSON.stringify(canonicalJob(job));
  db.prepare(SOURCE_UPSERT).run(
    job.project_id, job.company, job.role, job.city ?? null, job.pipeline ?? null,
    job.hc ?? null, job.active_state || 'UNKNOWN', job.priority ?? null, job.notes ?? null,
    job.company_type ?? null, job.owner_name ?? null, job.owner_unique_id ?? null,
    job.chat_id ?? null, job.source_url ?? null, job.captured_at || asOf,
    syncId, storedJson, now(),
  );
  return db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(job.project_id);
}

function sourceRecordId(meta) {
  return `jsr_${sha256([meta.tenantId, meta.sourceInstanceId, 'job', meta.externalId]).slice(0, 28)}`;
}

function evidenceRows(facts) {
  return Object.entries(facts).filter(([field, value]) => field !== 'project_id' && value !== null);
}

function attachEvidence(db, factVersion, facts, meta, {
  originKind,
  reviewStatus,
  sourceTime,
  evidence = {},
  extractionModel = null,
  promptVersion = null,
}) {
  const insert = db.prepare(`INSERT OR IGNORE INTO job_field_evidence
    (evidence_id, fact_version, field_path, value_json, origin_kind, evidence_ref,
     source_span, source_time, recorded_at, confidence, extraction_model,
     prompt_version, schema_version, review_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const [field, value] of evidenceRows(facts)) {
    const item = evidence[field];
    const ref = item?.ref || `${meta.sourceInstanceId}:${meta.externalId}`;
    const span = item?.span ?? (typeof item === 'string' ? item : null);
    const id = `jfe_${sha256([factVersion, field, ref]).slice(0, 28)}`;
    insert.run(id, factVersion, field, JSON.stringify(value), originKind, ref,
      span, sourceTime || meta.observedAt, now(), item?.confidence || 'HIGH',
      extractionModel, promptVersion, meta.schemaVersion, reviewStatus);
  }
}

function recordConflicts(db, latest, incomingFacts, meta) {
  if (!latest || latest.source_instance_id === meta.sourceInstanceId) return;
  const previous = JSON.parse(latest.facts_json);
  const insert = db.prepare(`INSERT OR IGNORE INTO job_fact_conflicts
    (conflict_id, tenant_id, job_id, field_path, previous_fact_version,
     previous_source_instance_id, incoming_source_instance_id, previous_value_json,
     incoming_value_json, detected_at, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,'OPEN')`);
  for (const field of PROJECTION_FIELDS) {
    if (stableJson(previous[field] ?? null) === stableJson(incomingFacts[field] ?? null)) continue;
    const incomingJson = JSON.stringify(incomingFacts[field] ?? null);
    const id = `jfc_${sha256([latest.fact_version, field, meta.sourceInstanceId, incomingJson]).slice(0, 28)}`;
    insert.run(id, meta.tenantId, incomingFacts.project_id, field, latest.fact_version,
      latest.source_instance_id, meta.sourceInstanceId, JSON.stringify(previous[field] ?? null),
      incomingJson, now());
  }
}

function recordFactVersion(db, { projection, syncId, meta, originKind, reviewStatus, evidence = {} }) {
  const facts = canonicalJob(projection);
  const contentHash = sha256(facts);
  const recordId = sourceRecordId(meta);
  db.prepare(`INSERT INTO job_source_records
    (source_record_id, tenant_id, source_type, source_instance_id, entity_type,
     external_id, job_id, payload_hash, adapter_version, schema_version,
     source_snapshot_id, scope_json, observed_at, recorded_at, last_sync_id, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id, source_instance_id, entity_type, external_id) DO UPDATE SET
      job_id=excluded.job_id, payload_hash=excluded.payload_hash,
      adapter_version=excluded.adapter_version, schema_version=excluded.schema_version,
      source_snapshot_id=excluded.source_snapshot_id, scope_json=excluded.scope_json,
      observed_at=excluded.observed_at, recorded_at=excluded.recorded_at,
      last_sync_id=excluded.last_sync_id, active=1`).run(
    recordId, meta.tenantId, meta.sourceType, meta.sourceInstanceId, 'job', meta.externalId,
    facts.project_id, contentHash, meta.adapterVersion, meta.schemaVersion,
    meta.snapshotId, JSON.stringify(meta.scope || {}), meta.observedAt, now(), syncId, 1,
  );

  const latest = db.prepare(`SELECT * FROM job_fact_versions
    WHERE tenant_id=? AND job_id=? ORDER BY version DESC LIMIT 1`).get(meta.tenantId, facts.project_id);
  recordConflicts(db, latest, facts, meta);
  if (latest?.content_hash === contentHash) {
    attachEvidence(db, latest.fact_version, facts, meta, {
      originKind, reviewStatus, sourceTime: meta.observedAt, evidence,
    });
    return { fact_version: latest.fact_version, version: latest.version, created: false };
  }

  const version = (latest?.version || 0) + 1;
  const factVersion = `jfv_${sha256([meta.tenantId, facts.project_id, version, contentHash]).slice(0, 28)}`;
  db.prepare(`INSERT INTO job_fact_versions
    (fact_version, tenant_id, job_id, version, schema_version, source_type,
     source_instance_id, source_record_id, source_snapshot_id, content_hash,
     facts_json, observed_at, recorded_at, sync_id, origin_kind, review_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    factVersion, meta.tenantId, facts.project_id, version, meta.schemaVersion,
    meta.sourceType, meta.sourceInstanceId, recordId, meta.snapshotId, contentHash,
    JSON.stringify(facts), meta.observedAt, now(), syncId, originKind, reviewStatus,
  );
  attachEvidence(db, factVersion, facts, meta, {
    originKind, reviewStatus, sourceTime: meta.observedAt, evidence,
  });
  return { fact_version: factVersion, version, created: true };
}

/** 调用者持有事务；同步投影、版本、来源与证据因此同成同败。 */
export function writeSourceJobFact(db, { job, syncId, source, asOf, envelope }) {
  const projection = upsertProjection(db, { job, syncId, asOf });
  const meta = sourceRecordMeta(job, envelope);
  return recordFactVersion(db, {
    projection,
    syncId,
    meta: { ...meta, sourceType: meta.sourceType || source },
    originKind: 'SOURCE_FACT',
    reviewStatus: 'SOURCE',
    evidence: meta.evidence,
  });
}

/** 调用者持有事务；只有显式确认后的草稿可调用。 */
export function writeConfirmedJobFact(db, { draft, jobId, syncId, consultantId, created, chatId, at }) {
  const existing = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(jobId);
  const job = created ? {
    project_id: jobId,
    company: draft.company,
    role: draft.role,
    city: draft.city,
    pipeline: draft.pipeline_stage,
    hc: draft.hc,
    active_state: draft.active_state === 'UNKNOWN' ? 'UNKNOWN' : draft.active_state,
    chat_id: chatId,
    captured_at: at,
  } : {
    ...existing,
    city: draft.city ?? existing.city,
    pipeline: draft.pipeline_stage ?? existing.pipeline,
    hc: draft.hc ?? existing.hc,
    active_state: draft.active_state === 'UNKNOWN' ? existing.active_state : draft.active_state,
    captured_at: existing.captured_at,
  };
  const projection = upsertProjection(db, { job, syncId, asOf: at, rawJson: draft.raw_json });
  const evidence = {
    company: { span: draft.company_evidence },
    role: { span: draft.role_evidence },
    city: { span: draft.city_evidence },
    pipeline: { span: draft.pipeline_evidence },
    hc: { span: draft.hc_evidence },
    active_state: { span: draft.state_evidence },
  };
  return recordFactVersion(db, {
    projection,
    syncId,
    meta: {
      tenantId: 'brainx',
      sourceType: 'lark_extract',
      sourceInstanceId: `lark-confirm:${draft.origin || 'group'}`,
      externalId: draft.draft_id,
      adapterVersion: 'job-extract-confirm-v1',
      schemaVersion: 'canonical-job-v1',
      snapshotId: draft.event_id,
      observedAt: draft.extracted_at || at,
      scope: { consultant_id: consultantId, chat_id: draft.chat_id },
    },
    originKind: 'MANUAL_CONFIRMED',
    reviewStatus: 'CONFIRMED',
    evidence,
  });
}

export function compareJobFactProjection(db, { tenantId = 'brainx', jobIds = null } = {}) {
  const wanted = jobIds ? new Set(jobIds) : null;
  const versions = db.prepare(`SELECT v.* FROM job_fact_versions v
    JOIN (SELECT tenant_id, job_id, MAX(version) version FROM job_fact_versions
      WHERE tenant_id=? GROUP BY tenant_id, job_id) latest
    ON latest.tenant_id=v.tenant_id AND latest.job_id=v.job_id AND latest.version=v.version`).all(tenantId);
  const out = [];
  for (const version of versions) {
    if (wanted && !wanted.has(version.job_id)) continue;
    const projection = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(version.job_id);
    const expected = JSON.parse(version.facts_json);
    const actual = projection ? canonicalJob(projection) : null;
    const fields = actual ? Object.keys(expected).filter((field) => stableJson(expected[field]) !== stableJson(actual[field]))
      : Object.keys(expected);
    if (fields.length) out.push({
      job_id: version.job_id,
      fact_version: version.fact_version,
      sync_id: version.sync_id,
      observed_at: version.observed_at,
      fields,
      expected,
      actual,
    });
  }
  return out;
}

export function repairJobFactProjection(db, { tenantId = 'brainx', jobIds = null, dryRun = true } = {}) {
  const differences = compareJobFactProjection(db, { tenantId, jobIds });
  if (dryRun || differences.length === 0) return { dry_run: true, differences, repaired: 0 };
  const update = db.prepare(`UPDATE job_facts SET company=?, role=?, city=?, pipeline=?, hc=?,
    active_state=?, priority=?, notes=?, company_type=?, owner_name=?, owner_unique_id=?, chat_id=?,
    updated_at=? WHERE project_id=?`);
  const insert = db.prepare(`INSERT INTO job_facts
    (project_id, company, role, city, pipeline, hc, active_state, priority, notes,
     company_type, owner_name, owner_unique_id, chat_id, captured_at, sync_id, raw_json, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  try {
    for (const item of differences) {
      const f = item.expected;
      if (item.actual) {
        update.run(f.company, f.role, f.city, f.pipeline, f.hc, f.active_state, f.priority,
          f.notes, f.company_type, f.owner_name, f.owner_unique_id, f.chat_id, now(), item.job_id);
      } else {
        insert.run(item.job_id, f.company, f.role, f.city, f.pipeline, f.hc, f.active_state,
          f.priority, f.notes, f.company_type, f.owner_name, f.owner_unique_id, f.chat_id,
          item.observed_at, item.sync_id, JSON.stringify(f), now());
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { dry_run: false, differences, repaired: differences.length };
}
