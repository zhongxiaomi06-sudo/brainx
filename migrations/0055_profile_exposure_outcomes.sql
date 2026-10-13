-- 0055: 主动画像、短期信号、真实曝光与 Case 结果账本（specs/029）

CREATE TABLE consultant_profile_versions (
  profile_version TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  consultant_id   TEXT NOT NULL REFERENCES consultants(consultant_id),
  version         INTEGER NOT NULL,
  profile_json    TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  changed_by      TEXT NOT NULL,
  change_reason   TEXT,
  effective_at    TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  UNIQUE (tenant_id, consultant_id, version)
);
CREATE INDEX idx_profile_versions_latest
  ON consultant_profile_versions(tenant_id, consultant_id, version DESC);

CREATE TABLE consultant_signals (
  signal_id         TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  consultant_id     TEXT NOT NULL REFERENCES consultants(consultant_id),
  signal_type       TEXT NOT NULL,
  value_json        TEXT NOT NULL,
  source            TEXT NOT NULL,
  sample_count      INTEGER NOT NULL CHECK (sample_count >= 0),
  confidence        TEXT NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  algorithm_version TEXT NOT NULL,
  window_start      TEXT NOT NULL,
  window_end        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  revoked_at        TEXT,
  revoke_reason     TEXT,
  idempotency_key   TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_consultant_signals_current
  ON consultant_signals(tenant_id, consultant_id, expires_at, revoked_at);

CREATE TABLE recommendation_exposure_events (
  exposure_event_id TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  run_id            TEXT NOT NULL,
  decision_id       TEXT NOT NULL,
  impression_id     TEXT,
  consultant_id     TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  event_type        TEXT NOT NULL CHECK (event_type IN ('SERVED','VISIBLE')),
  channel           TEXT NOT NULL,
  position          INTEGER NOT NULL CHECK (position > 0),
  propensity        REAL,
  occurred_at       TEXT NOT NULL,
  received_at       TEXT NOT NULL
);
CREATE INDEX idx_exposure_decision_time
  ON recommendation_exposure_events(decision_id, occurred_at, received_at);

CREATE TABLE business_outcome_events (
  outcome_event_id   TEXT PRIMARY KEY,
  tenant_id          TEXT NOT NULL,
  source_instance_id TEXT NOT NULL,
  source_event_id    TEXT NOT NULL,
  case_id            TEXT,
  project_id         TEXT NOT NULL,
  consultant_id      TEXT,
  stage              TEXT NOT NULL,
  event_kind         TEXT NOT NULL CHECK (event_kind IN ('RECORDED','CORRECTED')),
  correction_of      TEXT,
  decision_id        TEXT,
  attribution_version TEXT,
  attributed         INTEGER NOT NULL CHECK (attributed IN (0,1)),
  value_json         TEXT NOT NULL,
  occurred_at        TEXT NOT NULL,
  received_at        TEXT NOT NULL,
  UNIQUE (tenant_id, source_instance_id, source_event_id)
);
CREATE INDEX idx_business_outcomes_case_time
  ON business_outcome_events(tenant_id, case_id, occurred_at, received_at);
CREATE INDEX idx_business_outcomes_decision
  ON business_outcome_events(decision_id, attributed);

ALTER TABLE job_outcomes ADD COLUMN tenant_id TEXT;
ALTER TABLE job_outcomes ADD COLUMN outcome_event_id TEXT;
ALTER TABLE job_outcomes ADD COLUMN case_id TEXT;
ALTER TABLE job_outcomes ADD COLUMN source_instance_id TEXT;
ALTER TABLE job_outcomes ADD COLUMN source_event_id TEXT;
ALTER TABLE job_outcomes ADD COLUMN correction_of TEXT;
ALTER TABLE job_outcomes ADD COLUMN attribution_version TEXT;
ALTER TABLE job_outcomes ADD COLUMN attributed INTEGER;
CREATE UNIQUE INDEX idx_job_outcomes_source_event
  ON job_outcomes(tenant_id, source_instance_id, source_event_id)
  WHERE source_event_id IS NOT NULL;
