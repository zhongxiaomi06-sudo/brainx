-- 0034: 管理员身份/群范围变更的脱敏审计账本。
CREATE TABLE IF NOT EXISTS agent_admin_events (
  event_id       TEXT PRIMARY KEY,
  action         TEXT NOT NULL CHECK(action IN ('BIND_IDENTITY','REVOKE_IDENTITY','GRANT_GROUP','REVOKE_GROUP')),
  actor_hash     TEXT NOT NULL,
  target_kind    TEXT NOT NULL CHECK(target_kind IN ('IDENTITY','GROUP')),
  target_hash    TEXT NOT NULL,
  result         TEXT NOT NULL CHECK(result IN ('APPLIED','UPDATED')),
  detail_json    TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_aae_time ON agent_admin_events(created_at);
