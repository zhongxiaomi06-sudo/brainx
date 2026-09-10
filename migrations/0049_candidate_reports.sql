-- 候选人 Offer 决策报告版本；只保存飞书文档引用和生成边界，不保存简历原文。
CREATE TABLE IF NOT EXISTS candidate_reports (
  report_id          TEXT PRIMARY KEY,
  decision_group_id  TEXT NOT NULL REFERENCES candidate_decision_groups(decision_group_id),
  tenant_id          TEXT NOT NULL,
  position_id        TEXT NOT NULL,
  candidate_ref      TEXT NOT NULL,
  version            INTEGER NOT NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  document_id        TEXT,
  document_url       TEXT,
  status             TEXT NOT NULL CHECK(status IN ('CREATING','READY','FAILED')),
  error_code         TEXT,
  error_message      TEXT,
  created_by         TEXT NOT NULL REFERENCES consultants(consultant_id),
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE(decision_group_id, version)
);
