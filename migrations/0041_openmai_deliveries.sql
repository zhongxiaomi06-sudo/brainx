-- 0041: OpenMai 结果到原飞书项目群的持久投递账本。
CREATE TABLE IF NOT EXISTS openmai_deliveries (
  delivery_id       TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  consultant_id     TEXT NOT NULL REFERENCES consultants(consultant_id),
  project_id        TEXT NOT NULL REFERENCES job_facts(project_id),
  chat_id           TEXT NOT NULL,
  result_status     TEXT NOT NULL CHECK(result_status IN ('done','failed')),
  delivery_status   TEXT NOT NULL CHECK(delivery_status IN ('PENDING','SENDING','SENT','FAILED')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at   TEXT NOT NULL,
  message_id        TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  sent_at           TEXT,
  UNIQUE(task_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_openmai_delivery_pending
  ON openmai_deliveries(delivery_status, next_attempt_at);
