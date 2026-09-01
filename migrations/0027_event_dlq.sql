-- 0027: event_dlq —— 不可 upcast 事件等价 DLQ（Step 0）
-- 权威契约: specs/001-step0-event-ledger/data-model.md。
-- 旧结构事件无法经 upcaster 转换时落此表并告警（FR-007）。
CREATE TABLE IF NOT EXISTS event_dlq (
  event_id     TEXT PRIMARY KEY,
  raw_payload  TEXT NOT NULL,
  reason       TEXT NOT NULL,                -- upcast_failed / schema_invalid
  failed_at    TEXT NOT NULL
);
