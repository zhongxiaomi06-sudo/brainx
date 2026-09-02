-- 0029: chat_contexts —— 飞书群登记表（Step 1）
-- 权威契约: specs/002-step1-lark-gateway/data-model.md。
-- 网关 processLarkEvent 只读此表；登记由 registerChatContext 运营脚本预填。
-- 未登记群默认 DENY（不进业务 inbox，只落 lark.ignored 审计留痕）。
CREATE TABLE IF NOT EXISTS chat_contexts (
  chat_id            TEXT PRIMARY KEY,        -- 飞书群 chat_id（oc_ 开头）
  enabled            INTEGER NOT NULL DEFAULT 1, -- 0/1 布尔（SQLite 无原生 bool）
  bot_mode           TEXT NOT NULL DEFAULT 'MENTION_ONLY', -- MENTION_ONLY | ALL
  default_deny_reason TEXT,                   -- 启停/未登记时的拒绝说明（可选）
  registered_at      TEXT NOT NULL,           -- ISO 8601
  updated_at         TEXT NOT NULL,           -- ISO 8601
  notes              TEXT                     -- 运营备注（非 PII 元数据）
);
