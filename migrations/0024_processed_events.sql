-- 0024: processed_events —— 消费者幂等标记（Step 0）
-- 权威契约: specs/001-step0-event-ledger/data-model.md。
-- consumeOnce() 在业务事务内写入标记；同一 event 不同消费者各自幂等。
CREATE TABLE IF NOT EXISTS processed_events (
  event_id      TEXT PRIMARY KEY,
  consumer_name TEXT NOT NULL,               -- e.g. bridge1-push-person
  processed_at  TEXT NOT NULL,
  UNIQUE(event_id, consumer_name)
);
