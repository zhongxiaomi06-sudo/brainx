-- 离线标签按发生/收到双时间切分。历史行保持 NULL，不反推或伪造时间。
ALTER TABLE decision_events ADD COLUMN received_at TEXT;
ALTER TABLE job_outcomes ADD COLUMN occurred_at TEXT;
ALTER TABLE job_outcomes ADD COLUMN received_at TEXT;

CREATE INDEX idx_events_decision_time
  ON decision_events(decision_id, occurred_at, received_at);
CREATE INDEX idx_outcomes_decision_time
  ON job_outcomes(decision_id, occurred_at, received_at);
