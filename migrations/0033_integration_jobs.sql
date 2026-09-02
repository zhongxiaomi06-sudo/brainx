-- 0033: 解析、同步、匹配与搜索任务的可恢复状态及原会话通知 outbox。
CREATE TABLE IF NOT EXISTS integration_jobs (
  job_id                  TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  consultant_id           TEXT NOT NULL REFERENCES consultants(consultant_id),
  kind                    TEXT NOT NULL CHECK(kind IN ('TALENT_SYNC','PARSE_DOCUMENT','MATCH_EVAL','SEARCH')),
  idempotency_key         TEXT NOT NULL UNIQUE,
  status                  TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  payload_json            TEXT NOT NULL DEFAULT '{}',
  result_ref              TEXT,
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  max_attempts            INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 10),
  lease_owner             TEXT,
  lease_expires_at        TEXT,
  cost_units              INTEGER NOT NULL DEFAULT 0 CHECK(cost_units >= 0),
  cost_limit              INTEGER NOT NULL DEFAULT 0 CHECK(cost_limit >= 0),
  requested_at            TEXT NOT NULL,
  started_at              TEXT,
  completed_at            TEXT,
  error_code              TEXT,
  error_summary           TEXT,
  updated_at              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ij_claim
  ON integration_jobs(status, lease_expires_at, requested_at);
CREATE INDEX IF NOT EXISTS idx_ij_subject
  ON integration_jobs(tenant_id, consultant_id, requested_at);

CREATE TABLE IF NOT EXISTS integration_outbox (
  outbox_id               TEXT PRIMARY KEY,
  job_id                  TEXT NOT NULL REFERENCES integration_jobs(job_id),
  channel                 TEXT NOT NULL,
  account_id              TEXT NOT NULL,
  target_hash             TEXT NOT NULL,
  thread_id_hash          TEXT,
  payload_ref             TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK(status IN ('PENDING','SENDING','SENT','FAILED','CANCELLED')),
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at         TEXT NOT NULL,
  sent_at                 TEXT,
  last_error_code         TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE(job_id, payload_ref)
);
CREATE INDEX IF NOT EXISTS idx_io_delivery
  ON integration_outbox(status, next_attempt_at);
