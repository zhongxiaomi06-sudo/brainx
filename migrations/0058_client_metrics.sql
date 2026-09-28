-- 0058: client_metrics —— 客户健康指标快照（specs/022 FR-2，第一批=报告快照导入）
-- 权威契约: specs/022-client-feedback-signals/spec.md FR-2 + docs/2026-09-25-first-batch-push.md。
-- 与 0054 client_profiles 分工：profiles=语义画像（招岗信号聚合），metrics=健康指标（8 指标+生命周期分档）。
-- 幂等：chat_id 主键 upsert，重跑同 source 覆盖同值；分位锚点按 anchor_version 冻结（红线：锚点漂移必须 bump 版本）。
CREATE TABLE IF NOT EXISTS client_metrics (
  chat_id            TEXT PRIMARY KEY,
  client_name        TEXT,                    -- 报告中的客户名（群名片段）
  c_feedback_hours   REAL,                    -- 客户侧：反馈速度（小时，扣周末）
  c_decision_days    REAL,                    -- 客户侧：决策效率（初面至落槌，天；第一批全零暂不可用）
  o_resp_hours       REAL,                    -- 顾问侧：响应速度（约面敲定，小时）
  o_gap_days         REAL,                    -- 顾问侧：推荐节奏（平均间歇，天）
  o_max_gap_days     REAL,                    -- 顾问侧：最大断档（天）
  o_intent_coverage  REAL,                    -- 顾问侧：候选人掌控力（意向覆盖 %）
  o_push_freq        REAL,                    -- 顾问侧：推进自驱力（人均催促频次）
  rec_count          INTEGER NOT NULL DEFAULT 0,
  cand_unique        INTEGER NOT NULL DEFAULT 0,
  msg_total          INTEGER NOT NULL DEFAULT 0,
  stage              TEXT NOT NULL,           -- mature|calibration|cold_start|dormant
  health_badge       TEXT,                    -- green|yellow|red|blue（报告 final_badge）
  window_days        INTEGER NOT NULL DEFAULT 90,
  source             TEXT NOT NULL,           -- report-snapshot-2026-09-18 | daily-compute（US2 落地后）
  computed_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_metrics_stage ON client_metrics(stage);

-- 大盘分位锚点：随 anchor_version 冻结，ltr-feat-v2 特征归一化只读本表
CREATE TABLE IF NOT EXISTS client_metric_benchmarks (
  metric_key     TEXT NOT NULL,               -- c_feedback_hours|o_resp_hours|o_gap_days|o_max_gap_days|o_intent_coverage|o_push_freq
  anchor_version TEXT NOT NULL,               -- 如 ltr-feat-v2-anchor-2026-09-18
  p25 REAL NOT NULL, p50 REAL NOT NULL, p75 REAL NOT NULL,
  computed_at    TEXT NOT NULL,
  PRIMARY KEY (metric_key, anchor_version)
);
