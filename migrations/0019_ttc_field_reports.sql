-- 每次 TTC 同步的字段覆盖率快照；用于解释当时哪些字段可展示、可筛选。
CREATE TABLE IF NOT EXISTS ttc_field_reports (
  sync_id        TEXT PRIMARY KEY REFERENCES sync_runs(sync_id) ON DELETE CASCADE,
  consultant_id  TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  total_rows     INTEGER NOT NULL DEFAULT 0,
  report_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ttc_field_reports_consultant_created
  ON ttc_field_reports(consultant_id, created_at DESC);
