-- 0051: judgment_facts —— 顾问判断抽取回路（群消息 → 判断草稿 → 人工确认 → 权威表）
-- 权威契约: docs/2026-09-22-judgment-extraction.md；模式复刻 0031_job_facts_drafts：
-- 抽取与确认分离，草稿永不直写权威表；*_evidence 为原文锚定片段，
-- 无 evidence 的字段不得进权威表（宁缺勿错）。

-- staging：抽取草稿（pending|confirmed|rejected）
CREATE TABLE IF NOT EXISTS judgment_drafts (
  draft_id          TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES workflow_event_log(event_id), -- 来源账本事件（幂等消费单位）
  message_id        TEXT NOT NULL,           -- 来源消息（lark_messages）
  chat_id           TEXT,                    -- 来源群
  project_id        TEXT,                    -- 确认人转正时指定的关联职位（抽取阶段恒空）
  subject_type      TEXT,                    -- CLIENT_COMPANY|PROJECT|CANDIDATE|GENERAL
  subject_ref       TEXT, subject_evidence TEXT, -- 判断对象 + 原文锚点
  kind              TEXT,                    -- PREFERENCE|CONSTRAINT|EXCEPTION|REJECTION|EVALUATION
  statement         TEXT, statement_evidence TEXT, -- 归一化陈述 + 原文锚点
  confidence        TEXT,                    -- high|medium|low
  source            TEXT NOT NULL,           -- rules | llm（AI_JUDGMENT_EXTRACT_ENABLED 开启后）
  status            TEXT NOT NULL DEFAULT 'pending',
  raw_json          TEXT NOT NULL,           -- 完整 zod schema 输出存档
  extracted_at      TEXT NOT NULL,
  confirmed_at      TEXT,
  confirmed_by      TEXT
);
CREATE INDEX IF NOT EXISTS idx_jd_status  ON judgment_drafts(status);
CREATE INDEX IF NOT EXISTS idx_jd_message ON judgment_drafts(message_id);

-- 权威表：确认后的顾问判断（V1 只追加，supersede 语义留待后续）
CREATE TABLE IF NOT EXISTS judgment_facts (
  judgment_id   TEXT PRIMARY KEY,
  subject_type  TEXT NOT NULL,
  subject_ref   TEXT NOT NULL,
  kind          TEXT NOT NULL,             -- PREFERENCE|CONSTRAINT|EXCEPTION|REJECTION|EVALUATION
  statement     TEXT NOT NULL,
  evidence      TEXT NOT NULL,             -- 原文锚点（无 evidence 不进本表）
  project_id    TEXT,                      -- 确认时关联的职位（可空）
  draft_id      TEXT NOT NULL REFERENCES judgment_drafts(draft_id), -- 血缘：来源草稿
  sync_id       TEXT NOT NULL,             -- 血缘：sync_runs(source='lark_judgment_extract')
  confirmed_by  TEXT NOT NULL,
  captured_at   TEXT NOT NULL,
  raw_json      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jf_subject ON judgment_facts(subject_type, subject_ref);
CREATE INDEX IF NOT EXISTS idx_jf_project ON judgment_facts(project_id);
