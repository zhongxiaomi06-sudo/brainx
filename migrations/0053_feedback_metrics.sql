-- 0053: feedback_metrics —— 反馈指标快照表（specs/019 US3）
-- 权威契约: specs/019-hub-event-backbone/data-model.md + contracts/event-types.md（指标口径）。
-- append-only：同一窗口可重算，重算产生新快照行（inputs_json 带口径版本），历史行不改写；
-- 0 样本指标也必须落行（sample_size=0），防止静默漏数。
CREATE TABLE IF NOT EXISTS feedback_metrics (
  snapshot_id  TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,             -- 统计窗口起（ISO 8601，含）
  window_end   TEXT NOT NULL,             -- 统计窗口止（ISO 8601，不含）
  metric_key   TEXT NOT NULL,             -- recommendation.accept_rate / extract.field_confirm_rate / sourcing.channel_conversion / job.terminal_cycle_days
  dimension    TEXT NOT NULL DEFAULT '',  -- 维度切片（channel=openmai、domain=judgment；无维度为空串）
  sample_size  INTEGER NOT NULL,          -- 样本量（0 也落行）
  value_num    REAL,                      -- 指标值（比率 0..1 或天数）；NULL 时 inputs_json 须说明
  inputs_json  TEXT NOT NULL,             -- 口径输入摘要（事件类型、过滤、口径版本）
  computed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fm_key_dim_window ON feedback_metrics(metric_key, dimension, window_end);
