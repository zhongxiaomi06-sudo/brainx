-- 重点候选人的独立决策群；保留来源群和脱敏摘要，不保存简历原文或联系方式。
CREATE TABLE IF NOT EXISTS candidate_decision_groups (
  decision_group_id TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  position_id       TEXT NOT NULL REFERENCES job_facts(project_id),
  candidate_ref     TEXT NOT NULL,
  created_by        TEXT NOT NULL REFERENCES consultants(consultant_id),
  source_chat_id    TEXT NOT NULL,
  target_chat_id    TEXT,
  target_chat_name  TEXT,
  context_summary   TEXT NOT NULL,
  status            TEXT NOT NULL CHECK(status IN ('CREATING_CHAT','POSTING_CONTEXT','READY','FAILED')),
  error_code        TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(tenant_id, position_id, candidate_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_decision_group_chat
  ON candidate_decision_groups(target_chat_id) WHERE target_chat_id IS NOT NULL;
