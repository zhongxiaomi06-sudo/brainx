-- 0057: Algorithm A 独立运行、generation/CAS 与原序推荐项（specs/031）

CREATE TABLE agentic_ranking_generations (
  tenant_id         TEXT NOT NULL,
  consultant_id     TEXT NOT NULL,
  current_generation INTEGER NOT NULL CHECK (current_generation > 0),
  updated_at        TEXT NOT NULL,
  PRIMARY KEY (tenant_id, consultant_id)
);

CREATE TABLE agentic_ranking_runs (
  run_id                    TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  consultant_id             TEXT NOT NULL,
  generation                INTEGER NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN
                            ('RUNNING','VALIDATING','PUBLISHED','ABSTAINED',
                             'FAILED','CANCELLED','STALE')),
  algorithm_version         TEXT NOT NULL,
  source_snapshot_id        TEXT NOT NULL,
  profile_version           TEXT NOT NULL,
  signal_snapshot_id        TEXT NOT NULL,
  load_version              TEXT NOT NULL,
  authorization_version     TEXT NOT NULL,
  candidate_set_ref         TEXT NOT NULL,
  model_id                  TEXT NOT NULL,
  prompt_version            TEXT NOT NULL,
  tool_schema_version       TEXT NOT NULL,
  eligibility_policy_version TEXT NOT NULL,
  diversity_policy_version  TEXT NOT NULL,
  budget_json               TEXT NOT NULL,
  input_json                TEXT NOT NULL,
  output_json               TEXT,
  validation_errors_json    TEXT NOT NULL DEFAULT '[]',
  eligible_count            INTEGER NOT NULL,
  retrieved_count           INTEGER NOT NULL,
  reviewed_count            INTEGER NOT NULL DEFAULT 0,
  tool_call_count           INTEGER NOT NULL DEFAULT 0,
  repair_count              INTEGER NOT NULL DEFAULT 0,
  failure_code              TEXT,
  created_at                TEXT NOT NULL,
  finished_at               TEXT,
  UNIQUE (tenant_id, consultant_id, generation)
);
CREATE INDEX idx_agentic_runs_latest
  ON agentic_ranking_runs(tenant_id, consultant_id, generation DESC);

CREATE TABLE agentic_ranking_items (
  decision_id          TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL REFERENCES agentic_ranking_runs(run_id),
  tenant_id            TEXT NOT NULL,
  consultant_id        TEXT NOT NULL,
  job_id               TEXT NOT NULL,
  job_fact_version     TEXT NOT NULL,
  rank                 INTEGER NOT NULL CHECK (rank > 0),
  decision_tier        TEXT NOT NULL,
  reason_codes_json    TEXT NOT NULL,
  reason               TEXT NOT NULL,
  tradeoff             TEXT NOT NULL,
  evidence_refs_json   TEXT NOT NULL,
  uncertainties_json   TEXT NOT NULL,
  suggested_next_action TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  UNIQUE (run_id, rank),
  UNIQUE (run_id, job_id)
);
CREATE INDEX idx_agentic_items_run ON agentic_ranking_items(run_id, rank);
