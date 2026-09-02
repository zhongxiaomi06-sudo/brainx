-- 0023: workflow_event_log —— Step 0 事件账本（append-only）
-- 权威契约: specs/001-step0-event-ledger/data-model.md；蓝图 §5 Step 0。
-- 单行 = 一个业务事实；生产者幂等由 idem_key 唯一索引兜底；
-- append-only：不提供 UPDATE/DELETE 路径，修正以补偿事件表达。
CREATE TABLE IF NOT EXISTS workflow_event_log (
  event_id       TEXT PRIMARY KEY,            -- uuid
  idem_key       TEXT NOT NULL,               -- 生产者幂等键（业务语义：event_type + 来源实体 + 序号）
  event_type     TEXT NOT NULL,               -- e.g. case.stage_advanced / sourcing.run_finished
  case_id        TEXT,                        -- 双轴实体锚点（可空：非 Case 事件）
  actor          TEXT NOT NULL,               -- 主语：user:<open_id> / agent:<tool> / system:<job>
  occurred_at    TEXT NOT NULL,               -- ISO 8601
  payload        TEXT NOT NULL,               -- JSON（经 envelope 校验）
  evidence_refs  TEXT NOT NULL DEFAULT '[]',  -- JSON 数组：仅引用（表名+主键），禁止 PII 正文
  schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wel_idem ON workflow_event_log(idem_key);
CREATE INDEX IF NOT EXISTS idx_wel_case ON workflow_event_log(case_id, occurred_at);
