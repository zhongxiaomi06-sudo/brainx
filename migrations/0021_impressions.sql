-- 0021_impressions.sql — 曝光埋点与热路径索引（算法文档 §2.4/§2.5/§6）。

-- 展示位置与展示概率：每次冻结推荐时按 rank 记录（推荐即曝光候选），
-- 列表接口实际下发时回填 served_at；探索位记 propensity 供位置偏差修正。
CREATE TABLE IF NOT EXISTS recommendation_impressions (
  impression_id  TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL REFERENCES decision_runs(run_id) ON DELETE CASCADE,
  decision_id    TEXT NOT NULL,
  consultant_id  TEXT NOT NULL,
  project_id     TEXT NOT NULL,
  rank           INTEGER NOT NULL,
  slot_kind      TEXT NOT NULL DEFAULT 'NORMAL' CHECK (slot_kind IN ('NORMAL','EXPLORATION')),
  propensity     REAL NOT NULL DEFAULT 1.0,   -- 该位置被曝光的概率（NORMAL=1，探索位=ε）
  policy_version TEXT NOT NULL,
  served_at      TEXT,                        -- 列表接口真实下发时间（NULL=未进用户视野）
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_impressions_consultant_created
  ON recommendation_impressions(consultant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_impressions_run ON recommendation_impressions(run_id);
CREATE INDEX IF NOT EXISTS idx_impressions_pid ON recommendation_impressions(consultant_id, project_id);

-- 热路径索引：职位详情/可见性/状态机回退按 (consultant_id, project_id) 探测，
-- 此前只能 (consultant_id) 前缀过滤后逐行回表（137 万行表上实测未命中 0.46s）。
CREATE INDEX IF NOT EXISTS idx_recs_consultant_project
  ON recommendations(consultant_id, project_id);

-- 反馈去重压到库层：应用层 check-then-insert 在双进程/重试竞态下会产重复行。
-- 先清理历史重复（保留每 (consultant_id, project_id, snapshot_id) 最早一行），再建唯一索引。
DELETE FROM recommendation_feedback
WHERE rowid NOT IN (SELECT MIN(rowid) FROM recommendation_feedback
                    GROUP BY consultant_id, project_id, snapshot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique
  ON recommendation_feedback(consultant_id, project_id, snapshot_id);
