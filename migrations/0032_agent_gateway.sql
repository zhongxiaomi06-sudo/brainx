-- 0032: OpenClaw 生产 Agent Gateway 的身份、群范围、审计和重放防护。
-- 不保存消息正文、完整 prompt、简历、联系方式、token 或密钥。
CREATE TABLE IF NOT EXISTS feishu_identity_bindings (
  binding_id             TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  channel_account_id     TEXT NOT NULL,
  feishu_app_key_hash    TEXT NOT NULL CHECK(length(feishu_app_key_hash) = 64),
  open_id                TEXT NOT NULL,
  union_id               TEXT,
  consultant_id          TEXT NOT NULL REFERENCES consultants(consultant_id),
  employee_ref           TEXT,
  binding_status         TEXT NOT NULL CHECK(binding_status IN ('PENDING','ACTIVE','REVOKED')),
  verified_at            TEXT NOT NULL,
  verified_by            TEXT NOT NULL,
  revoked_at             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fib_active_sender
  ON feishu_identity_bindings(channel_account_id, open_id)
  WHERE binding_status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_fib_consultant
  ON feishu_identity_bindings(tenant_id, consultant_id, binding_status);

CREATE TABLE IF NOT EXISTS agent_group_scopes (
  group_scope_id          TEXT PRIMARY KEY,
  tenant_id               TEXT NOT NULL,
  channel_account_id      TEXT NOT NULL,
  chat_id                 TEXT NOT NULL,
  scope_status            TEXT NOT NULL CHECK(scope_status IN ('ACTIVE','REVOKED')),
  allowed_purposes_json   TEXT NOT NULL DEFAULT '[]',
  allowed_senders_json    TEXT NOT NULL DEFAULT '[]',
  project_refs_json       TEXT NOT NULL DEFAULT '[]',
  require_mention         INTEGER NOT NULL DEFAULT 1 CHECK(require_mention IN (0,1)),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  revoked_at              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ags_active_chat
  ON agent_group_scopes(channel_account_id, chat_id)
  WHERE scope_status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id                  TEXT PRIMARY KEY,
  request_id              TEXT NOT NULL UNIQUE,
  tenant_id               TEXT,
  consultant_id           TEXT,
  channel                 TEXT NOT NULL,
  account_id              TEXT NOT NULL,
  chat_type               TEXT NOT NULL CHECK(chat_type IN ('p2p','group')),
  sender_hash             TEXT NOT NULL,
  chat_id_hash            TEXT NOT NULL,
  purpose                 TEXT NOT NULL,
  tool_name               TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK(status IN ('RECEIVED','AUTHORIZED','SUCCEEDED','REFUSED','FAILED')),
  model_ref               TEXT,
  skill_version           TEXT,
  started_at              TEXT NOT NULL,
  completed_at            TEXT,
  error_code              TEXT
);
CREATE INDEX IF NOT EXISTS idx_ar_subject_time
  ON agent_runs(tenant_id, consultant_id, started_at);

CREATE TABLE IF NOT EXISTS agent_tool_calls (
  tool_call_id            TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL REFERENCES agent_runs(run_id),
  tool_name               TEXT NOT NULL,
  tool_version            TEXT NOT NULL,
  arguments_hash          TEXT NOT NULL,
  arguments_summary_json  TEXT NOT NULL DEFAULT '{}',
  authorization_result    TEXT NOT NULL,
  policy_version          TEXT NOT NULL,
  data_versions_json      TEXT NOT NULL DEFAULT '{}',
  evidence_refs_json      TEXT NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL CHECK(status IN ('STARTED','SUCCEEDED','REFUSED','FAILED')),
  duration_ms             INTEGER,
  error_code              TEXT,
  created_at              TEXT NOT NULL,
  completed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_atc_run ON agent_tool_calls(run_id, created_at);

CREATE TABLE IF NOT EXISTS agent_nonces (
  nonce                   TEXT PRIMARY KEY,
  request_id              TEXT NOT NULL UNIQUE,
  expires_at              TEXT NOT NULL,
  consumed_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_an_expiry ON agent_nonces(expires_at);

CREATE TABLE IF NOT EXISTS agent_rate_limits (
  bucket_key              TEXT PRIMARY KEY,
  window_started_at       TEXT NOT NULL,
  request_count           INTEGER NOT NULL DEFAULT 0 CHECK(request_count >= 0),
  updated_at              TEXT NOT NULL
);
