/** agent-facts.js — job_agent_facts 存储层（specs/023 施工序②）。
 *
 * 权威契约: specs/023-fact-agent/spec.md FR-1；
 * 职责：表读写、按职位取最新有效值、幂等 upsert、结构化统计。
 * 纪律：
 *  - 幂等键 message_id+field+project_id；**唯一性由两层保证**：
 *    职位级行（project_id 非空）靠 PRIMARY KEY；**群级行（NULL）不被主键唯一性覆盖
 *    （SQL 复合主键里 NULL 与 NULL 互不相等，INSERT OR IGNORE 永不触发冲突）**——
 *    幂等由写前存在性预检补齐（下 EXISTS_SQL），首写优先，重抽不覆盖（审计链稳定）。
 *  - 抽取行必须可回溯：evidence 原文锚点 + message_id + model，缺一不落库（FR-6），
 *    不合格行进返回值 invalid 列表由调用方计数，不静默丢（禁止静默失败）。
 *  - 群级行（project_id NULL）与 confidence<0.7 的行本层照存——「永不进合成」
 *    是合成层（src/facts.js，施工序④）的过滤口径，存储保持中立。
 */

export const AGENT_FACT_FIELDS = ['current_stage', 'active_state'];
export const AGENT_SYNTHESIS_THRESHOLD = 0.7; // >=0.7 才进合成（specs/023 FR-1）
const EVIDENCE_MAX = 200;

/** 群级行幂等预检：NULL 不参与主键唯一性（NULL≠NULL），必须 NULL 安全比较。 */
const EXISTS_SQL = `
  SELECT 1 FROM job_agent_facts
  WHERE message_id = ? AND field = ?
    AND ((project_id IS NULL AND ? IS NULL) OR project_id = ?)
  LIMIT 1`;

const INSERT_SQL = `
  INSERT OR IGNORE INTO job_agent_facts
    (message_id, chat_id, project_id, field, value, confidence, evidence, model, extracted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * 校验并幂等写入一批 agent 事实。
 * @param {object} db
 * @param {Array<{message_id,chat_id,project_id?,field,value,confidence,evidence,model}>} rows
 * @param {string} [extractedAt] ISO 8601 UTC，缺省当前时刻
 * @returns {{inserted:number, duplicates:number, invalid:Array<{row:object,reason:string}>}}
 */
export function upsertAgentFacts(db, rows, extractedAt = null) {
  const at = extractedAt || new Date().toISOString();
  let inserted = 0;
  let duplicates = 0;
  const invalid = [];
  for (const row of rows || []) {
    const v = validateAgentFactRow(row);
    if (!v.ok) { invalid.push({ row, reason: v.reason }); continue; }
    const pid = row.project_id ?? null;
    // 群级行（NULL）主键不防重：预检命中即 duplicates（职位级行命中也走同路，语义一致）
    if (db.prepare(EXISTS_SQL).get(row.message_id, row.field, pid, pid)) {
      duplicates += 1;
      continue;
    }
    db.prepare(INSERT_SQL).run(
      row.message_id, row.chat_id, pid,
      row.field, row.value, row.confidence,
      String(row.evidence).slice(0, EVIDENCE_MAX),
      row.model, at,
    );
    inserted += 1;
  }
  return { inserted, duplicates, invalid };
}

/** 单行契约校验：字段枚举、confidence 范围、可回溯三要素（evidence/message_id/model）。 */
export function validateAgentFactRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'not_object' };
  if (!row.message_id) return { ok: false, reason: 'message_id_missing' };
  if (!row.chat_id) return { ok: false, reason: 'chat_id_missing' };
  if (!AGENT_FACT_FIELDS.includes(row.field)) return { ok: false, reason: `field_invalid:${row.field}` };
  if (typeof row.value !== 'string' || !row.value.trim()) return { ok: false, reason: 'value_empty' };
  const c = Number(row.confidence);
  if (!Number.isFinite(c) || c < 0 || c > 1) return { ok: false, reason: `confidence_invalid:${row.confidence}` };
  if (typeof row.evidence !== 'string' || !row.evidence.trim()) return { ok: false, reason: 'evidence_missing' };
  if (typeof row.model !== 'string' || !row.model.trim()) return { ok: false, reason: 'model_missing' };
  return { ok: true };
}

/**
 * 按职位取某字段的最新 agent 事实（30 天窗口由调用方/合成层裁剪——存储中立）。
 * @returns {{value,confidence,evidence,extracted_at,model}|null}
 */
export function latestAgentFact(db, projectId, field) {
  const row = db.prepare(`
    SELECT value, confidence, evidence, extracted_at, model
    FROM job_agent_facts
    WHERE project_id = ? AND field = ?
    ORDER BY extracted_at DESC
    LIMIT 1`).get(projectId, field);
  return row || null;
}

/** 按职位取全部字段的最新有效值（合成层 effectiveJob 的消费入口）。 */
export function latestAgentFactsForJob(db, projectId) {
  const out = {};
  for (const field of AGENT_FACT_FIELDS) {
    const row = latestAgentFact(db, projectId, field);
    if (row) out[field] = row;
  }
  return out;
}

/** 群级信号（project_id IS NULL）按群取最新——仅展示通道，合成层禁用。 */
export function latestGroupFactsByChat(db, chatId) {
  return db.prepare(`
    SELECT field, value, confidence, evidence, extracted_at
    FROM job_agent_facts
    WHERE chat_id = ? AND project_id IS NULL
    ORDER BY extracted_at DESC`).all(chatId);
}

/** 结构化统计（FR-6 观测口径：字段分布 / 职位级 vs 群级 / 置信分布）。 */
export function statsAgentFacts(db) {
  const total = db.prepare('SELECT COUNT(*) n FROM job_agent_facts').get().n;
  const byField = db.prepare(
    'SELECT field, COUNT(*) n FROM job_agent_facts GROUP BY field').all();
  const byLevel = db.prepare(`
    SELECT CASE WHEN project_id IS NULL THEN 'group' ELSE 'job' END level,
           COUNT(*) n FROM job_agent_facts GROUP BY level`).all();
  const byConfidence = db.prepare(`
    SELECT CASE WHEN confidence >= ? THEN 'synthesis_eligible' ELSE 'below_threshold' END band,
           COUNT(*) n FROM job_agent_facts GROUP BY band`).all(AGENT_SYNTHESIS_THRESHOLD);
  const distinctJobs = db.prepare(
    'SELECT COUNT(DISTINCT project_id) n FROM job_agent_facts WHERE project_id IS NOT NULL').get().n;
  return { total, byField, byLevel, byConfidence, distinctJobs };
}
