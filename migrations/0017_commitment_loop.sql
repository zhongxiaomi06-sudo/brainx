-- 承接行动闭环：行动是主轴，阶段仅作为结果标签。
CREATE TABLE commitment_actions (
  action_id        TEXT PRIMARY KEY,
  consultant_id    TEXT NOT NULL,
  project_id       TEXT NOT NULL REFERENCES job_facts(project_id),
  title            TEXT NOT NULL,
  goal             TEXT,
  due_at           TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('OPEN','BLOCKED','DONE','CANCELLED')),
  source           TEXT NOT NULL CHECK (source IN ('RULE','MANUAL')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT,
  completion_note  TEXT,
  idempotency_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_commitment_actions_history
  ON commitment_actions(consultant_id, project_id, created_at);
CREATE UNIQUE INDEX idx_commitment_actions_current
  ON commitment_actions(consultant_id, project_id)
  WHERE status IN ('OPEN','BLOCKED');

ALTER TABLE job_outcomes ADD COLUMN action_id TEXT REFERENCES commitment_actions(action_id);
ALTER TABLE job_outcomes ADD COLUMN kind TEXT NOT NULL DEFAULT 'STAGE';
CREATE INDEX idx_outcomes_kind ON job_outcomes(consultant_id, project_id, kind, observed_at);
