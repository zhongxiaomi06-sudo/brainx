-- 0057: job_agent_facts（specs/023 字段补全 Agent，第二供给线）。
-- GLM 从 lark_messages 抽取的职位级事实（MVP 两字段：current_stage / active_state）。
-- 与 T7 Pipeline 渠道（第一供给线，specs/023 §背景）在合成层汇合：
-- effectiveJob 优先级 manual > AGENT(conf>=0.7) > cockpit_facts > sync（FR-3，施工序④接线）。
--
-- 幂等键 = message_id + field + project_id（FR-1 红线：缺一不可）。
-- ⚠️ 唯一性是两层机制，别只看主键：职位级行（project_id 非空）由主键防重；
-- **群级行（NULL）不被主键唯一性覆盖——SQL 复合主键里 NULL 与 NULL 互不相等**。
-- 群级防重靠下方部分唯一索引（原子，覆盖手工 CLI 与 timer 并行的 TOCTOU 竞态；
-- 存储层写前预检只做 duplicates 计数与快路径，非唯一性保证）。
-- 运维纪律：timer 保持单实例（部分唯一索引是数据兜底，不是并发设计的替身）。
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

-- 群级行唯一性（原子）：主键对 NULL 不防重（NULL≠NULL），此索引补上
-- （message_id+field 在群级维度唯一——chat_id 不参与幂等键，同消息唯一）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_facts_group
  ON job_agent_facts(message_id, field) WHERE project_id IS NULL;
