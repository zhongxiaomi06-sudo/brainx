-- 0025: entity_links —— 跨系统身份链接（Step 0）
-- 权威契约: specs/001-step0-event-ledger/data-model.md。
-- case_id 为唯一跨系统锚点；任一侧 ID 可解析全链（US4）。
CREATE TABLE IF NOT EXISTS entity_links (
  case_id       TEXT PRIMARY KEY REFERENCES cases(case_id),
  brainx_id     TEXT,
  talent_pool_id TEXT,
  reloop_id     TEXT,
  lark_open_id  TEXT,
  updated_at    TEXT NOT NULL
);
