-- 0026: cases —— Case 双轴状态机（Step 0）
-- 权威契约: specs/001-step0-event-ledger/data-model.md。
-- milestone 轴: DISCOVERED→QUALIFIED→CONSENTED→SUBMITTED→INTERVIEW→OFFER→PLACED
-- outreach 轴: NOT_CONTACTED→SENT→DELIVERED→REPLIED
-- version 为乐观锁；合法迁移表由 src/hub/case-machine.js 常量权威定义。
CREATE TABLE IF NOT EXISTS cases (
  case_id       TEXT PRIMARY KEY,            -- uuid（唯一跨系统锚点）
  position_id   TEXT NOT NULL,
  candidate_ref TEXT NOT NULL,               -- 人选引用（不存明文 PII）
  milestone     TEXT NOT NULL DEFAULT 'DISCOVERED',
  outreach_state TEXT NOT NULL DEFAULT 'NOT_CONTACTED',
  version       INTEGER NOT NULL DEFAULT 1,  -- 乐观锁
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(position_id, candidate_ref)
);
