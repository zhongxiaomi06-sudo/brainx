-- OpenClaw 与工作台共享的顾问候选人推进状态；只保存不含 PII 的引用和状态。
CREATE TABLE IF NOT EXISTS consultant_candidate_cases (
  case_id         TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  consultant_id   TEXT NOT NULL REFERENCES consultants(consultant_id),
  position_id     TEXT NOT NULL,
  candidate_ref   TEXT NOT NULL,
  milestone       TEXT NOT NULL DEFAULT 'DISCOVERED'
    CHECK(milestone IN ('DISCOVERED','SUBMITTED','INTERVIEW')),
  outreach_state  TEXT NOT NULL DEFAULT 'NOT_CONTACTED'
    CHECK(outreach_state IN ('NOT_CONTACTED','PREPARING','SENT','REPLIED')),
  last_note       TEXT,
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE(tenant_id, consultant_id, position_id, candidate_ref)
);
CREATE INDEX IF NOT EXISTS idx_ccc_owner_position
  ON consultant_candidate_cases(tenant_id, consultant_id, position_id, updated_at);
