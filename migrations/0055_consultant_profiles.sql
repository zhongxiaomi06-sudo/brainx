-- 0055: 顾问画像表（冷启动第一批对应，与 client_profiles 对称）。
-- 信号：ACCEPTED x2 + 在任 membership x1 + VIEWED x0.3，按 job_facts 文本映射岗位族。
-- 由 bin/brainx-consultant-profiles.mjs 导入，幂等 upsert。消费方：routed push / 召回权重。
CREATE TABLE IF NOT EXISTS consultant_profiles (
  consultant_id     TEXT PRIMARY KEY,
  accepted_count    INTEGER NOT NULL DEFAULT 0,
  viewed_count      INTEGER NOT NULL DEFAULT 0,
  active_jobs       INTEGER NOT NULL DEFAULT 0,
  role_families_json TEXT NOT NULL DEFAULT '{}',
  top_family        TEXT,
  companies_json    TEXT NOT NULL DEFAULT '{}',
  computed_at       TEXT NOT NULL
);
