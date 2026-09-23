-- 0054: 客户画像表（冷启动第一批，specs/022 client_metrics 的画像前置面）。
-- 数据来源：GLM 语义清洗全量判定（8,131 条 rejected + pending）按 chat_id 聚合，
-- 由 bin/brainx-client-profiles.mjs 导入，幂等 upsert。只读消费方：推荐匹配/召回过滤。
CREATE TABLE IF NOT EXISTS client_profiles (
  chat_id          TEXT PRIMARY KEY,
  msg_count        INTEGER NOT NULL DEFAULT 0,   -- 清洗窗口内消息总数
  real_job_count   INTEGER NOT NULL DEFAULT 0,   -- GLM 判 REAL_JOB 的招岗信号数
  suspected_count  INTEGER NOT NULL DEFAULT 0,   -- SUSPECTED 数
  companies_json   TEXT NOT NULL DEFAULT '{}',   -- {company: 提及次数} top8
  role_families_json TEXT NOT NULL DEFAULT '{}', -- {岗位族: 次数} top6
  role_samples_json  TEXT NOT NULL DEFAULT '[]', -- role_hint 样例 top6
  cities_json      TEXT NOT NULL DEFAULT '{}',   -- {city: 次数} top5
  first_seen       TEXT,                          -- 窗口内最早信号时间
  last_seen        TEXT,                          -- 窗口内最晚信号时间
  computed_at      TEXT NOT NULL                  -- 画像计算时间
);
CREATE INDEX IF NOT EXISTS idx_client_profiles_real ON client_profiles(real_job_count);
