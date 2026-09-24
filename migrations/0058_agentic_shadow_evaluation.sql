-- 0058: Algorithm A 冻结评估计划与不可投递影子证据（specs/032）

ALTER TABLE agentic_ranking_runs ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'LIVE'
  CHECK (run_mode IN ('LIVE','SHADOW'));
CREATE INDEX idx_agentic_runs_mode_latest
  ON agentic_ranking_runs(tenant_id, consultant_id, run_mode, generation DESC);

CREATE TABLE shadow_evaluation_plans (
  plan_id                  TEXT PRIMARY KEY,
  tenant_id                TEXT NOT NULL,
  name                     TEXT NOT NULL,
  metric_version           TEXT NOT NULL,
  label_definition_version TEXT NOT NULL,
  thresholds_json          TEXT NOT NULL,
  segments_json            TEXT NOT NULL,
  status                   TEXT NOT NULL CHECK (status='FROZEN'),
  created_by               TEXT NOT NULL,
  created_at               TEXT NOT NULL
);
CREATE INDEX idx_shadow_plans_tenant
  ON shadow_evaluation_plans(tenant_id, created_at DESC);

CREATE TABLE shadow_evaluation_runs (
  shadow_run_id          TEXT PRIMARY KEY,
  plan_id                TEXT NOT NULL REFERENCES shadow_evaluation_plans(plan_id),
  tenant_id              TEXT NOT NULL,
  consultant_id          TEXT NOT NULL,
  scenario               TEXT NOT NULL CHECK (scenario IN
                          ('REPEAT','CANDIDATE_ORDER_PERTURBED','LONG_TEXT',
                           'MISSING_PROFILE','COLD_START','SOURCE_CONFLICT',
                           'MALICIOUS_CONTENT')),
  segment                TEXT NOT NULL,
  status                 TEXT NOT NULL CHECK (status IN ('RUNNING','SHADOW_COMPLETED','FAILED')),
  agentic_run_id         TEXT REFERENCES agentic_ranking_runs(run_id),
  reference_shadow_run_id TEXT REFERENCES shadow_evaluation_runs(shadow_run_id),
  authorization_version  TEXT NOT NULL,
  as_of                  TEXT,
  source_snapshot_id     TEXT,
  candidate_set_ref      TEXT,
  baseline_json          TEXT,
  agentic_json           TEXT,
  metrics_json           TEXT,
  stability_json         TEXT,
  evidence_json          TEXT,
  hard_violation_count   INTEGER NOT NULL DEFAULT 0 CHECK (hard_violation_count >= 0),
  delivery_attempted     INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempted=0),
  exposure_count         INTEGER NOT NULL DEFAULT 0 CHECK (exposure_count=0),
  business_outcome_status TEXT NOT NULL DEFAULT 'NOT_AVAILABLE_IN_SHADOW'
    CHECK (business_outcome_status='NOT_AVAILABLE_IN_SHADOW'),
  failure_code           TEXT,
  created_at             TEXT NOT NULL,
  finished_at            TEXT
);
CREATE INDEX idx_shadow_runs_plan
  ON shadow_evaluation_runs(tenant_id, plan_id, status, created_at DESC);
CREATE INDEX idx_shadow_runs_candidate_set
  ON shadow_evaluation_runs(plan_id, consultant_id, candidate_set_ref);
