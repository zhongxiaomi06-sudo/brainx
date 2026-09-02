-- 0030: lark_messages —— 飞书消息正文落库（E1 提炼层输入）
-- 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4；
-- 规格 002 data-model 留下的「消息正文落库后续规格决定」由本迁移补齐：
-- 事件账本 payload 不含正文 PII（FR-006），evidence_refs 指向本表，
-- 提炼层（job-extract 消费者）从这里读原文抽取。
-- 只有通过网关的事件（lark.message_received）落此表；DENY 事件不落。
CREATE TABLE IF NOT EXISTS lark_messages (
  message_id   TEXT PRIMARY KEY,          -- 飞书 message_id（幂等键）
  chat_id      TEXT NOT NULL,             -- 来源群/会话
  message_type TEXT,                      -- text | post | ...（非文本消息正文可能为空）
  text         TEXT,                      -- 解密后正文原文（提炼输入与审计依据）
  mentions_json TEXT,                     -- 归一后 open_id 数组的 JSON 串
  create_time  TEXT NOT NULL,             -- 消息产生时间（ISO 8601）
  received_at  TEXT NOT NULL              -- 网关接收时间（ISO 8601）
);
CREATE INDEX IF NOT EXISTS idx_lm_chat ON lark_messages(chat_id);
