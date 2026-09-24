-- 0057: job_agent_facts（specs/023 字段补全 Agent，第二供给线）。
-- GLM 从 lark_messages 抽取的职位级事实（MVP 两字段：current_stage / active_state）。
-- 与 T7 Pipeline 渠道（第一供给线，specs/023 §背景）在合成层汇合：
-- effectiveJob 优先级 manual > AGENT(conf>=0.7) > cockpit_facts > sync（FR-3，施工序④接线）。
--
-- 幂等键 = message_id + field + project_id（FR-1 红线：缺一不可；
-- SQLite 主键 NULL 互不冲突 → 群级行（project_id IS NULL）不塌缩）。
-- 时间戳一律 ISO 8601 UTC（库内既有约定）；evidence 是原文锚点（截断 200 字符）。
-- 红线：群级行与 confidence<0.7 的行【只存储展示，永不进合成层】（合成层过滤，
-- 本表不强制——存储层保持中立，消费口径在 src/facts.js）。

CREATE TABLE IF NOT EXISTS job_agent_facts (
  message_id   TEXT NOT NULL,
  chat_id      TEXT NOT NULL,
  project_id   TEXT,              -- NULL = 群级信号（仅存储展示，不进合成）
  field        TEXT NOT NULL,     -- current_stage / active_state（MVP 两项）
  value        TEXT NOT NULL,
  confidence   REAL NOT NULL,     -- [0,1]，>=0.7 才进合成
  evidence     TEXT NOT NULL,     -- 原文锚点，截断 200 字符
  model        TEXT NOT NULL,     -- 引擎标识+版本，如 glm-4-flash-v1
  extracted_at TEXT NOT NULL,
  PRIMARY KEY (message_id, field, project_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_facts_job
  ON job_agent_facts(project_id, field, extracted_at);
