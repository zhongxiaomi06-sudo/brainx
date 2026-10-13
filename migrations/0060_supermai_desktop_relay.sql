-- 0060: SuperMai 桌面出站 relay。云端不接触招聘平台 Cookie，设备只凭独立可撤销 token 领任务。
CREATE TABLE IF NOT EXISTS supermai_pair_codes (
  code_hash       TEXT PRIMARY KEY,
  consultant_id   TEXT NOT NULL REFERENCES consultants(consultant_id),
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  used_at         TEXT
);

CREATE TABLE IF NOT EXISTS supermai_devices (
  device_id       TEXT PRIMARY KEY,
  consultant_id   TEXT NOT NULL REFERENCES consultants(consultant_id),
  name            TEXT NOT NULL,
  platform        TEXT NOT NULL,
  connector_version TEXT,
  token_hash      TEXT NOT NULL UNIQUE,
  state_json      TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT,
  revoked_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_supermai_devices_owner
  ON supermai_devices(consultant_id, revoked_at, last_seen_at);

CREATE TABLE IF NOT EXISTS sourcing_tasks (
  task_id         TEXT PRIMARY KEY,
  consultant_id   TEXT NOT NULL REFERENCES consultants(consultant_id),
  project_id      TEXT NOT NULL,
  provider        TEXT NOT NULL CHECK(provider IN ('supermai')),
  criteria        TEXT NOT NULL,
  platforms_json  TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN (
    'queued','waiting_for_device','waiting_for_user','running',
    'completed','partial','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  device_id       TEXT REFERENCES supermai_devices(device_id),
  lease_expires_at TEXT,
  ingest_token_hash TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT,
  error_code      TEXT,
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sourcing_tasks_claim
  ON sourcing_tasks(consultant_id, provider, status, created_at);

CREATE TABLE IF NOT EXISTS sourcing_task_events (
  event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES sourcing_tasks(task_id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sourcing_task_events_task
  ON sourcing_task_events(task_id, event_id);

CREATE TABLE IF NOT EXISTS sourcing_results (
  task_id         TEXT NOT NULL REFERENCES sourcing_tasks(task_id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY(task_id, platform, external_id)
);

CREATE TABLE IF NOT EXISTS supermai_commands (
  command_id      TEXT PRIMARY KEY,
  consultant_id   TEXT NOT NULL REFERENCES consultants(consultant_id),
  device_id       TEXT REFERENCES supermai_devices(device_id),
  command         TEXT NOT NULL CHECK(command IN ('open_login')),
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  finished_at     TEXT,
  error_message   TEXT
);
CREATE INDEX IF NOT EXISTS idx_supermai_commands_claim
  ON supermai_commands(consultant_id, status, created_at);
