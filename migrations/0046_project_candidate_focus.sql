-- 项目共享的候选人重点名单；只保存稳定引用和选择状态，不保存联系方式或简历原文。
CREATE TABLE IF NOT EXISTS project_candidate_focus (
  tenant_id      TEXT NOT NULL,
  position_id    TEXT NOT NULL,
  candidate_ref  TEXT NOT NULL,
  focus_status   TEXT NOT NULL DEFAULT 'FOCUSED'
    CHECK(focus_status IN ('FOCUSED','REMOVED')),
  selected_by    TEXT NOT NULL REFERENCES consultants(consultant_id),
  source_task_id TEXT,
  candidate_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (tenant_id, position_id, candidate_ref)
);
CREATE INDEX IF NOT EXISTS idx_pcf_project_status
  ON project_candidate_focus(tenant_id, position_id, focus_status, updated_at);
