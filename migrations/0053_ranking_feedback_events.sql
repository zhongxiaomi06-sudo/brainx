-- 负反馈按追加事件回放；现有忽略/反馈表继续作为当前态兼容投影。
CREATE TABLE IF NOT EXISTS recommendation_feedback_events (
  event_id TEXT PRIMARY KEY,
  consultant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  decision_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN ('NEGATIVE','REVOKED','REASON_CORRECTED')),
  reason_code TEXT CHECK(reason_code IS NULL OR reason_code IN
    ('NO_CAPACITY','DIRECTION_MISMATCH','JOB_QUALITY','OTHER_CONSULTANT','INSUFFICIENT_INFO','OTHER')),
  reason_text TEXT,
  source TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_feedback_events_decision_time
  ON recommendation_feedback_events(decision_id, occurred_at, received_at);
CREATE INDEX idx_feedback_events_consultant_project_time
  ON recommendation_feedback_events(consultant_id, project_id, occurred_at, received_at);
