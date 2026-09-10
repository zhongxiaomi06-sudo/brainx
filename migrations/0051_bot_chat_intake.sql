-- 0051：发现机器人新加入的群并以最小权限进入待绑定态。
CREATE TABLE IF NOT EXISTS bot_chat_intake (
  chat_id             TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  channel_account_id  TEXT NOT NULL,
  chat_name           TEXT,
  status              TEXT NOT NULL CHECK(status IN ('BASELINED','PENDING','CARD_SENT','BOUND','SKIPPED')),
  first_seen_at       TEXT NOT NULL,
  card_sent_at        TEXT,
  project_id          TEXT,
  error_code          TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bot_chat_intake_state (
  singleton             INTEGER PRIMARY KEY CHECK(singleton=1),
  baseline_completed_at TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_chat_intake_status
  ON bot_chat_intake(status, updated_at);
