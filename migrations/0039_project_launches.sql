-- 0039: 职位启动飞书项目群的可恢复状态；外部调用前先落账，重试不重复建群。
CREATE TABLE IF NOT EXISTS project_launches (
  launch_id        TEXT PRIMARY KEY,
  consultant_id    TEXT NOT NULL REFERENCES consultants(consultant_id),
  project_id       TEXT NOT NULL REFERENCES job_facts(project_id),
  idempotency_key  TEXT NOT NULL,
  status           TEXT NOT NULL CHECK(status IN ('CREATING_CHAT','POSTING_JOB','READY','FAILED')),
  current_step     TEXT NOT NULL,
  chat_id          TEXT,
  chat_name        TEXT,
  message_id       TEXT,
  error_code       TEXT,
  error_message    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE(consultant_id, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_launch_chat
  ON project_launches(chat_id) WHERE chat_id IS NOT NULL;
