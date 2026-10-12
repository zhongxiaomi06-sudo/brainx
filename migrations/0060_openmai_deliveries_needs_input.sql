-- 0060: openmai_deliveries 的 result_status CHECK 补 needs_input（2026-10-09 审计实证）。
-- 0041 建表时 CHECK 只允许 done/failed，而 settleOpenmaiTask 会产生 needs_input
-- （OpenMai 澄清反问，openmai-task.js），enqueueOpenmaiDeliveries 也明确选出
-- needs_input——旧 INSERT OR IGNORE 把 CHECK 冲突静默跳过，「请补充职位信息」卡
-- 永远到不了项目群，project_launches.search_status 卡 RUNNING 直至超龄。
-- SQLite 不能修改 CHECK 约束，按官方推荐重建表（迁移 runner 已提供事务）。
CREATE TABLE openmai_deliveries_new (
  delivery_id       TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  consultant_id     TEXT NOT NULL REFERENCES consultants(consultant_id),
  project_id        TEXT NOT NULL REFERENCES job_facts(project_id),
  chat_id           TEXT NOT NULL,
  result_status     TEXT NOT NULL CHECK(result_status IN ('done','needs_input','failed')),
  delivery_status   TEXT NOT NULL CHECK(delivery_status IN ('PENDING','SENDING','SENT','FAILED')),
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt_at   TEXT NOT NULL,
  message_id        TEXT,
  last_error        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  sent_at           TEXT,
  UNIQUE(task_id, chat_id)
);
INSERT INTO openmai_deliveries_new SELECT * FROM openmai_deliveries;
DROP TABLE openmai_deliveries;
ALTER TABLE openmai_deliveries_new RENAME TO openmai_deliveries;
CREATE INDEX IF NOT EXISTS idx_openmai_delivery_pending
  ON openmai_deliveries(delivery_status, next_attempt_at);
