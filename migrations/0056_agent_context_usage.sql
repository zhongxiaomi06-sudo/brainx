-- 0056: Agent 逐尝试用量账本与授权上下文注册表（specs/030）

CREATE TABLE agent_usage_calls (
  call_id              TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL,
  tenant_id            TEXT NOT NULL,
  consultant_id        TEXT NOT NULL,
  round                 INTEGER NOT NULL CHECK (round > 0),
  attempt               INTEGER NOT NULL CHECK (attempt > 0),
  provider_id           TEXT NOT NULL,
  model_id              TEXT NOT NULL,
  request_ref           TEXT,
  status                TEXT NOT NULL CHECK (status IN
                          ('PENDING','SUCCEEDED','FAILED','CANCELLED','CACHED','UNKNOWN')),
  usage_status          TEXT NOT NULL CHECK (usage_status IN ('KNOWN','PARTIAL','UNKNOWN')),
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  total_tokens          INTEGER,
  cached_input_tokens   INTEGER,
  reasoning_tokens      INTEGER,
  price_version         TEXT,
  estimated_cost_micros INTEGER,
  currency              TEXT,
  latency_ms            INTEGER,
  tool_count            INTEGER NOT NULL DEFAULT 0,
  context_refs_json     TEXT NOT NULL DEFAULT '[]',
  error_code            TEXT,
  started_at            TEXT NOT NULL,
  completed_at          TEXT,
  UNIQUE (run_id, round, attempt)
);
CREATE INDEX idx_agent_usage_run ON agent_usage_calls(tenant_id, run_id, round, attempt);

CREATE TABLE context_registry_entries (
  context_id       TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  source_type      TEXT NOT NULL,
  source_id        TEXT NOT NULL,
  source_version   TEXT NOT NULL,
  scope_hash       TEXT NOT NULL,
  summary          TEXT NOT NULL,
  content_json     TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  size_bytes       INTEGER NOT NULL CHECK (size_bytes >= 0),
  expires_at       TEXT NOT NULL,
  truncated        INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1)),
  revoked_at       TEXT,
  revoke_reason    TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_context_registry_scope
  ON context_registry_entries(tenant_id, scope_hash, expires_at, revoked_at);

CREATE TABLE agent_run_context_refs (
  run_id       TEXT NOT NULL,
  context_id   TEXT NOT NULL REFERENCES context_registry_entries(context_id),
  accessed_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, context_id)
);
