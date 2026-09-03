-- 顾问个人模型的非敏感审计投影；API Key 仅保存在 OpenClaw 个人 Agent 认证库。
CREATE TABLE IF NOT EXISTS consultant_model_profiles (
  consultant_id     TEXT PRIMARY KEY REFERENCES consultants(consultant_id),
  feishu_account_id TEXT NOT NULL,
  agent_id           TEXT NOT NULL UNIQUE,
  provider_id        TEXT NOT NULL
    CHECK(provider_id IN ('openai','anthropic','google','stepfun')),
  model_id           TEXT NOT NULL,
  profile_id         TEXT NOT NULL,
  status             TEXT NOT NULL
    CHECK(status IN ('PENDING','ACTIVE','ERROR','DISABLED')),
  consent_version    TEXT NOT NULL,
  consented_at       TEXT NOT NULL,
  configured_at      TEXT,
  disabled_at        TEXT,
  last_error_code    TEXT,
  updated_at         TEXT NOT NULL,
  CHECK(status != 'ACTIVE' OR configured_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cmp_status_updated
  ON consultant_model_profiles(status, updated_at);
