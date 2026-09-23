-- 0054: 统一职位来源、不可变事实版本、字段证据、冲突与提炼缓存（specs/028）

CREATE TABLE job_source_records (
  source_record_id   TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  source_type        TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  entity_type        TEXT NOT NULL DEFAULT 'job',
  external_id        TEXT NOT NULL,
  job_id             TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  adapter_version    TEXT NOT NULL,
  schema_version     TEXT NOT NULL,
  source_snapshot_id TEXT,
  scope_json         TEXT NOT NULL DEFAULT '{}',
  observed_at        TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  last_sync_id       TEXT NOT NULL REFERENCES sync_runs(sync_id),
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  UNIQUE (tenant_id, source_instance_id, entity_type, external_id)
);
CREATE INDEX idx_job_source_records_job ON job_source_records(tenant_id, job_id, active);

CREATE TABLE job_fact_versions (
  fact_version       TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  job_id             TEXT NOT NULL,
  version            INTEGER NOT NULL,
  schema_version     TEXT NOT NULL,
  source_type        TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_record_id   TEXT NOT NULL REFERENCES job_source_records(source_record_id),
  source_snapshot_id TEXT,
  content_hash       TEXT NOT NULL,
  facts_json         TEXT NOT NULL,
  observed_at        TEXT NOT NULL,
  recorded_at        TEXT NOT NULL,
  sync_id            TEXT NOT NULL REFERENCES sync_runs(sync_id),
  origin_kind        TEXT NOT NULL CHECK (origin_kind IN ('SOURCE_FACT','MANUAL_CONFIRMED','SOFT_INFERENCE')),
  review_status      TEXT NOT NULL CHECK (review_status IN ('SOURCE','CONFIRMED','PENDING')),
  UNIQUE (tenant_id, job_id, version)
);
CREATE INDEX idx_job_fact_versions_latest ON job_fact_versions(tenant_id, job_id, version DESC);
CREATE INDEX idx_job_fact_versions_hash ON job_fact_versions(tenant_id, job_id, content_hash);

CREATE TABLE job_field_evidence (
  evidence_id        TEXT PRIMARY KEY,
  fact_version       TEXT NOT NULL REFERENCES job_fact_versions(fact_version) ON DELETE CASCADE,
  field_path         TEXT NOT NULL,
  value_json         TEXT,
  origin_kind        TEXT NOT NULL CHECK (origin_kind IN ('SOURCE_FACT','MANUAL_CONFIRMED','SOFT_INFERENCE')),
  evidence_ref       TEXT NOT NULL,
  source_span        TEXT,
  source_time        TEXT,
  recorded_at        TEXT NOT NULL,
  confidence         TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  extraction_model   TEXT,
  prompt_version     TEXT,
  schema_version     TEXT NOT NULL,
  review_status      TEXT NOT NULL CHECK (review_status IN ('SOURCE','CONFIRMED','PENDING')),
  UNIQUE (fact_version, field_path, evidence_ref)
);
CREATE INDEX idx_job_field_evidence_version ON job_field_evidence(fact_version, field_path);

CREATE TABLE job_fact_conflicts (
  conflict_id                 TEXT PRIMARY KEY,
  tenant_id                   TEXT NOT NULL,
  job_id                      TEXT NOT NULL,
  field_path                  TEXT NOT NULL,
  previous_fact_version       TEXT NOT NULL REFERENCES job_fact_versions(fact_version),
  previous_source_instance_id TEXT NOT NULL,
  incoming_source_instance_id TEXT NOT NULL,
  previous_value_json         TEXT,
  incoming_value_json         TEXT,
  detected_at                 TEXT NOT NULL,
  status                      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED','IGNORED')),
  UNIQUE (job_id, field_path, previous_fact_version, incoming_source_instance_id, incoming_value_json)
);
CREATE INDEX idx_job_fact_conflicts_open ON job_fact_conflicts(tenant_id, status, job_id);

CREATE TABLE job_extraction_cache (
  cache_key         TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  scope_hash        TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  model_id          TEXT NOT NULL,
  prompt_version    TEXT NOT NULL,
  result_json       TEXT NOT NULL,
  layer             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_used_at      TEXT NOT NULL,
  hit_count         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, scope_hash, content_hash, extractor_version, model_id, prompt_version)
);
