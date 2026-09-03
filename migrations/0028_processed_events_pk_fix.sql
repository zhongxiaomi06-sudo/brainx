-- 0028: 修正 processed_events 主键（测试 hub-consumer.test.mjs 暴露）。
-- 0024 中 event_id 单列 PRIMARY KEY 与 UNIQUE(event_id, consumer_name) 语义矛盾：
-- 单列 PK 导致第二个消费者无法对同一事件落标记，"不同消费者各自幂等"失效。
-- 重建为复合主键，保留既有数据。消费幂等权威语义见 specs/001-step0-event-ledger/spec.md FR-002。
CREATE TABLE processed_events_new (
  event_id      TEXT NOT NULL,
  consumer_name TEXT NOT NULL,
  processed_at  TEXT NOT NULL,
  PRIMARY KEY (event_id, consumer_name)
);

INSERT INTO processed_events_new (event_id, consumer_name, processed_at)
  SELECT event_id, consumer_name, processed_at FROM processed_events;

DROP TABLE processed_events;
ALTER TABLE processed_events_new RENAME TO processed_events;
