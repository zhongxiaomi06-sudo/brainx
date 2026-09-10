-- 0050: 机器人进旧群的入群登记（specs/015）。
-- 轮询 GET /open-apis/im/v1/chats 发现机器人所在群；首轮全部记 SEEN 不发卡（避免轰炸历史群含死群），
-- 之后新出现的群走「发绑定职位卡 → 绑定 → BOUND」流程。
CREATE TABLE IF NOT EXISTS bot_chat_intake (
  chat_id        TEXT PRIMARY KEY,
  chat_name      TEXT,
  status         TEXT NOT NULL DEFAULT 'SEEN',   -- SEEN | CARD_SENT | BOUND | SKIPPED
  first_seen_at  TEXT NOT NULL,
  card_sent_at   TEXT,
  project_id     TEXT,
  updated_at     TEXT NOT NULL
);
