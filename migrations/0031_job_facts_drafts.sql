-- 0031: job_facts_drafts —— 群消息提炼草稿 staging 表（E1）
-- 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4-§5；
-- 抽取与确认分离（open_recruiter 模式）：提炼结果只落本表，
-- 经人工确认或 MCP brainx_confirm_facts（E3，须带 jobVisibleTo 守门）才进 job_facts 权威表。
-- 字段与 0001_init.job_facts 对齐；*_evidence 为原文锚定片段（langextract 思想），
-- 无 evidence 的字段不得进权威表。
CREATE TABLE IF NOT EXISTS job_facts_drafts (
  draft_id        TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES workflow_event_log(event_id), -- 来源账本事件（幂等消费单位）
  message_id      TEXT NOT NULL,           -- 来源消息
  chat_id         TEXT,                    -- 来源群
  project_id      TEXT,                    -- entity_links 命中的既有职位（E4 接入；E1 恒空）
  company         TEXT, company_evidence   TEXT,
  role            TEXT, role_evidence      TEXT,
  city            TEXT, city_evidence      TEXT,
  pipeline_stage  TEXT,                    -- SOURCING|SCREENING|INTERVIEW|OFFER|ONBOARD|CLOSED
  pipeline_evidence TEXT,
  hc              INTEGER, hc_evidence     TEXT,
  active_state    TEXT NOT NULL DEFAULT 'UNKNOWN', -- OPEN|CLOSED|ON_HOLD|COMPLETED|COOLING|UNKNOWN
  state_evidence  TEXT,
  source          TEXT NOT NULL,           -- rules | llm（AI_JOB_EXTRACT_ENABLED 开启后）
  status          TEXT NOT NULL DEFAULT 'pending', -- pending|confirmed|rejected
  raw_json        TEXT NOT NULL,           -- 完整 zod schema 输出存档（含逐字段置信度）
  extracted_at    TEXT NOT NULL,
  confirmed_at    TEXT,
  confirmed_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_jfd_status  ON job_facts_drafts(status);
CREATE INDEX IF NOT EXISTS idx_jfd_message ON job_facts_drafts(message_id);
