-- 0015_openmai_results.sql — 接单自动找人结果表（方案：接单 ACCEPT → 自动触发 OpenMai 找人 → 结果回传前端）。
-- 防重纪律：同 (project_id, consultant_id) 主键唯一，至多一条最新记录；done 后默认复用结果，
-- 重新找人只能走显式 rerun（POST /api/v1/opportunities/:id/openmai/rerun），避免误触发消耗配额。
CREATE TABLE IF NOT EXISTS openmai_results (
  project_id     TEXT NOT NULL,
  consultant_id  TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',  -- running / done / failed
  result_text    TEXT,                             -- OpenMai 返回的候选人结果（markdown 原文）
  error          TEXT,
  task_id        TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  PRIMARY KEY (project_id, consultant_id)
);
