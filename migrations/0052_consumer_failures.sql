-- 0052: consumer_failures —— dispatcher 消费失败重试/死信台账（specs/019 US2）
-- 权威契约: specs/019-hub-event-backbone/contracts/event-types.md（消费者注册契约）。
-- 与 event_dlq（0027，upcast 失败）职责不同：本表按「事件 × 消费者」记账——
-- attempts < maxRetries 时下一轮重试；达到上限且未 resolved 即死信（dispatcher 跳过）；
-- replayConsumerFailure 置 resolved_at 后事件回到可派发集合。
CREATE TABLE IF NOT EXISTS consumer_failures (
  event_id        TEXT NOT NULL,
  consumer_name   TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  first_failed_at TEXT NOT NULL,
  last_failed_at  TEXT NOT NULL,
  resolved_at     TEXT,
  PRIMARY KEY (event_id, consumer_name)
);
CREATE INDEX IF NOT EXISTS idx_cf_consumer ON consumer_failures(consumer_name, resolved_at);
