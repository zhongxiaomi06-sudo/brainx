/** fact-agent-extract.js — 字段补全 Agent 抽取管线（specs/023 施工序③，框架）。
 *
 * 权威契约: specs/023-fact-agent/spec.md FR-2/FR-5/FR-6；
 * 管线：lark_messages → post 富文本拍平 → 信号正则预筛（零 token）→ GLM 批量抽取
 * （每批 ≤20 条，单条失败不阻塞批次）→ 消歧三分叉 → 受控枚举归一化 → 落库。
 *
 * 架构纪律（复刻 job-extract/judgment-extract 同款）：
 *  - LLM 不进核心：runFactAgentPipeline 接受注入的 llm(batch) 异步函数，本模块零网络 IO；
 *  - kill-switch 在调用方（bin CLI）：BRAINX_FACT_AGENT!==1 时绝不含 llm 绝不写库，
 *    只跑解析+预筛并输出统计（AC：零 token、零落库）；
 *  - 宁缺勿错：无原文锚定的 evidence 丢弃、非法枚举丢弃、confidence<0.7 落库但不进合成；
 *  - 消歧三分叉（FR-2）：1:1 群直落职位级；多职位群 GLM 指名（hint 相似度 >=0.7）才落
 *    职位级；指不出落群级（project_id NULL，仅存储展示，永不进合成）。
 */

import { AGENT_FACT_FIELDS, upsertAgentFacts } from './agent-facts.js';

// ---------------------------------------------------------------------------
// 受控枚举映射（spec §FR-1：映射表在代码常量，不在文档复制）
// ---------------------------------------------------------------------------

/** current_stage 受控枚举：GLM 原始说法 → 归一值。匹配用小写包含。 */
export const STAGE_ENUM = [
  { value: '一面', re: /一面|初面|首面|初筛|第?一轮|first\s*round/i },
  { value: '二面', re: /二面|复试|复面|第?二轮|second\s*round/i },
  { value: '终面', re: /三面|终面|第?三轮|final|最后一轮/i },
  { value: 'Offer', re: /offer|录用|发了.*(offer|聘书)/i },
  { value: '入职', re: /入职|到岗|onboard/i },
];

/** active_state 受控枚举：只认 OPEN/CLOSED/COOLING（spec FR-1）。 */
export const STATE_ENUM = ['OPEN', 'CLOSED', 'COOLING'];

/** 规则校验的矛盾词：GLM 判 OPEN 但原文出现这些 → 判定矛盾，丢弃（规则校验兜底）。 */
export const STATE_CONTRADICTION_RE = /暂停|满了|招完|关闭|停招|缓招|freeze/i;

// ---------------------------------------------------------------------------
// post 富文本拍平（specs/023 data-baseline §3：text 列存 {"title","content":[[...]]}）
// ---------------------------------------------------------------------------

/**
 * lark_messages.text → 纯文本。
 * post 富文本 JSON 拍平（递归拼 title + 各 text/a/at 元素）；其余原样返回。
 * 防御式：非法 JSON / 非预期形状一律回落原文（解析层永不抛错）。
 */
export function postToPlainText(raw) {
  const s = String(raw ?? '').trim();
  if (!s.startsWith('{')) return s;
  let obj;
  try { obj = JSON.parse(s); } catch { return s; }
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.content)) return s;
  const parts = [];
  if (typeof obj.title === 'string' && obj.title.trim()) parts.push(obj.title.trim());
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    if (typeof node.text === 'string') parts.push(node.text);
    if (typeof node.content === 'string' && !node.elements) parts.push(node.content); // a 标签
    if (node.elements) walk(node.elements);
  };
  walk(obj.content);
  return (parts.join('\n').trim()) || s;
}

// ---------------------------------------------------------------------------
// 信号预筛（零 token；口径对齐 data-baseline §3：阶段/offer/HC/状态四类关键词）
// ---------------------------------------------------------------------------

export const SIGNAL_RE =
  /一面|二面|三面|初面|终面|复试|面试|offer|录用|入职|到岗|hc|HC|headcount|招人|招聘|招满|满员|招完|停招|暂停|关闭|急招|长期招聘/i;

/** 信号相关性（规则先行：未命中零 LLM 成本）。 */
export function isSignalMessage(plainText) {
  if (!plainText) return false;
  return SIGNAL_RE.test(plainText);
}

// ---------------------------------------------------------------------------
// 归一化（非法值丢弃 —— 宁缺勿错）
// ---------------------------------------------------------------------------

/** GLM 原始值 → 受控枚举值；不可映射返回 null（调用方计 invalid）。 */
export function normalizeValue(field, rawValue, evidence = '') {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return null;
  if (field === 'current_stage') {
    const hit = STAGE_ENUM.find((e) => e.re.test(raw));
    return hit ? hit.value : null;
  }
  if (field === 'active_state') {
    const v = raw.toUpperCase();
    if (!STATE_ENUM.includes(v)) return null;
    // 规则校验：判 OPEN 但证据里全是矛盾词 → 丢弃（spec FR-1「GLM 判断 + 规则校验」）
    if (v === 'OPEN' && evidence && STATE_CONTRADICTION_RE.test(evidence)) return null;
    return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 消歧三分叉（FR-2）
// ---------------------------------------------------------------------------

/** 归一化字符串：小写、去空白与常见分隔符。 */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s·・,，、()（）-]/g, '');

/** hint 与职位的 company/role 相似度：包含关系=1；否则按字符交集比例（框架级，首轮验证后校准）。 */
export function hintSimilarity(hint, text) {
  const h = norm(hint);
  const t = norm(text);
  if (!h || !t) return 0;
  if (t.includes(h) || h.includes(t)) return 1;
  const hSet = new Set([...h]);
  let shared = 0;
  for (const ch of new Set([...t])) if (hSet.has(ch)) shared += 1;
  return shared / Math.max(hSet.size, new Set([...t]).size);
}

/**
 * GLM 指名 hint → 职位匹配。
 * @param {string|null} hint GLM 输出的公司/职位指名
 * @param {Array<{project_id,company,role}>} jobs 该群绑定的职位清单
 * @returns {{project_id:string}|null} 匹配不到返回 null（→ 群级）
 */
export function matchJobHint(hint, jobs) {
  if (!hint || !Array.isArray(jobs) || jobs.length === 0) return null;
  let best = { score: 0, job: null };
  for (const job of jobs) {
    const s = Math.max(hintSimilarity(hint, job.company), hintSimilarity(hint, job.role));
    if (s > best.score) best = { score: s, job };
  }
  return best.score >= 0.7 ? { project_id: best.job.project_id } : null;
}

/**
 * 消歧三分叉：1:1 群直落；多职位群按 GLM 指名；指不出落群级。
 * @returns {{project_id:string|null, fork:'single'|'named'|'group'}}
 */
export function disambiguate(fact, jobs) {
  if (jobs.length === 1) return { project_id: jobs[0].project_id, fork: 'single' };
  const named = matchJobHint(fact.project_hint, jobs);
  if (named) return { project_id: named.project_id, fork: 'named' };
  return { project_id: null, fork: 'group' };
}

// ---------------------------------------------------------------------------
// GLM 批量契约（输入 {chat_id, 群绑定职位清单, 消息纯文本}；输出带 message_id）
// ---------------------------------------------------------------------------

export function buildBatchPrompt(items) {
  const lines = items.map((it, i) => {
    const jobs = (it.jobs || []).map((j) => `${j.project_id}（${j.company}/${j.role}）`).join('；') || '（该群未绑定职位）';
    return `【消息${i + 1}】message_id=${it.message_id}\n群绑定职位：${jobs}\n正文：${it.plain.slice(0, 1500)}`;
  });
  return lines.join('\n\n');
}

export const FACT_AGENT_SYSTEM = `你是猎头业务群消息的职位事实抽取器。只输出 JSON。
从每条消息抽取两类字段（没有就给空数组，禁止推测编造）：
- current_stage：招聘流程阶段，原始说法照抄（如 一面/二面/终面/offer/入职）
- active_state：职位状态，只能取 OPEN(在招/急招/长期招聘)/CLOSED(招完/满员/关闭/停招)/COOLING(暂停/缓招)
每个字段必须带：value（原文说法）、confidence(0~1)、evidence(原文连续子串<=60字)。
群绑定多个职位时，若能从正文指认唯一职位，输出 project_hint（公司名或职位名）；指不出省略该字段。
输出格式：{"results":[{"message_id":"...","facts":[{"field":"current_stage|active_state","value":"...","project_hint":"...","confidence":0.9,"evidence":"..."}]}]}`;

/** GLM 批量回复解析：容忍围栏/杂文本；单条畸形丢该条不废整批（返回按 message_id 分组）。 */
export function parseBatchResponse(raw, batchMessageIds) {
  let obj;
  try {
    const t = String(raw ?? '').trim();
    obj = JSON.parse(t.startsWith('{') ? t : (t.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? t));
  } catch { return { ok: false, byMessage: new Map() }; }
  const byMessage = new Map();
  const ids = new Set(batchMessageIds);
  for (const r of Array.isArray(obj?.results) ? obj.results : []) {
    if (!r || typeof r.message_id !== 'string' || !ids.has(r.message_id)) continue;
    if (!Array.isArray(r.facts)) continue;
    byMessage.set(r.message_id, r.facts);
  }
  return { ok: true, byMessage };
}

/** LLM 抽出 fact（含 evidence 原文锚定校验）→ 落库行；不可信返回 null 并给原因。 */
export function factToRow(fact, item, modelName) {
  if (!fact || typeof fact !== 'object') return { row: null, reason: 'not_object' };
  const field = String(fact.field || '');
  if (!AGENT_FACT_FIELDS.includes(field)) return { row: null, reason: `field_invalid:${field}` };
  const evidence = String(fact.evidence || '').trim().slice(0, 200);
  if (!evidence) return { row: null, reason: 'evidence_missing' };
  if (!item.plain.includes(evidence.slice(0, Math.min(12, evidence.length)))) {
    return { row: null, reason: 'evidence_not_anchored' }; // 无原文锚定=丢弃（宁缺勿错）
  }
  const confidence = Number(fact.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { row: null, reason: 'confidence_invalid' };
  }
  const value = normalizeValue(field, fact.value, evidence);
  if (!value) return { row: null, reason: `value_unmappable:${fact.value}` };
  const { project_id, fork } = disambiguate(fact, item.jobs || []);
  return {
    row: {
      message_id: item.message_id,
      chat_id: item.chat_id,
      project_id,
      field,
      value,
      confidence,
      evidence,
      model: modelName,
    },
    reason: null,
    fork,
  };
}

// ---------------------------------------------------------------------------
// 管线编排
// ---------------------------------------------------------------------------

const SELECT_CANDIDATES_SQL = `
  SELECT message_id, chat_id, text, create_time
  FROM lark_messages
  WHERE text IS NOT NULL AND TRIM(text) != ''
    AND ($since IS NULL OR create_time > $since)
  ORDER BY create_time DESC
  LIMIT $limit`;

// 无上限版（backfill/存量语义：--limit 显式传才截断，禁默认静默截断）
const SELECT_CANDIDATES_UNBOUNDED_SQL = `
  SELECT message_id, chat_id, text, create_time
  FROM lark_messages
  WHERE text IS NOT NULL AND TRIM(text) != ''
    AND ($since IS NULL OR create_time > $since)
  ORDER BY create_time DESC`;

const SELECT_JOBS_SQL = `
  SELECT project_id, company, role FROM job_facts WHERE chat_id = ?`;

export function jobsForChat(db, chatId) {
  return db.prepare(SELECT_JOBS_SQL).all(chatId);
}

/**
 * 跑一轮抽取管线。
 * @param {object} db
 * @param {object} opts
 *   - llm: async ({system, user}) => string（注入；缺省=只跑解析+预筛，零 token）
 *   - modelName: 落库 model 标识（默认 'glm-fact-agent-v1'）
 *   - since/limit: 增量窗口与上限；limit=null 表示无上限（backfill 存量语义，缺省）
 *   - batchSize: 每批消息数（默认 20，spec FR-2）
 *   - extractedAt: 固定时间戳（测试用）
 * @returns {{stats:object, rows:object[]}} 统计与全部落库行（回放/影子对照用）
 */
export async function runFactAgentPipeline(db, opts = {}) {
  const { llm = null, modelName = 'glm-fact-agent-v1', since = null, limit = null, batchSize = 20 } = opts;
  const stats = {
    scanned: 0, candidates: 0, llmBatches: 0, llmFailures: 0,
    extracted: 0, inserted: 0, duplicates: 0, invalid: 0, dropReasons: {},
    byField: {}, fork: { single: 0, named: 0, group: 0 }, belowThreshold: 0,
  };
  const rows = [];

  const msgs = limit == null
    ? db.prepare(SELECT_CANDIDATES_UNBOUNDED_SQL).all({ $since: since })
    : db.prepare(SELECT_CANDIDATES_SQL).all({ $since: since, $limit: limit });
  stats.scanned = msgs.length;

  // 解析 + 预筛（零 token，开关关闭时的唯一执行路径）
  const candidates = [];
  for (const m of msgs) {
    const plain = postToPlainText(m.text);
    if (!isSignalMessage(plain)) continue;
    candidates.push({ message_id: m.message_id, chat_id: m.chat_id, plain, jobs: null });
  }
  stats.candidates = candidates.length;
  if (!llm || candidates.length === 0) return { stats, rows };

  // 每群职位清单懒加载（一次查询复用同群全部候选）
  const jobCache = new Map();
  for (const c of candidates) {
    if (!jobCache.has(c.chat_id)) jobCache.set(c.chat_id, jobsForChat(db, c.chat_id));
    c.jobs = jobCache.get(c.chat_id);
  }

  // 批量抽取：每批 ≤batchSize；单批失败计数不阻塞后续批次（FR-2 / US4）
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    let parsed;
    try {
      stats.llmBatches += 1;
      const raw = await llm({ system: FACT_AGENT_SYSTEM, user: buildBatchPrompt(batch) });
      parsed = parseBatchResponse(raw, batch.map((b) => b.message_id));
      if (!parsed.ok) throw new Error('batch_response_unparseable');
    } catch {
      stats.llmFailures += 1;
      continue; // 失败批次留待下轮重试（幂等键天然去重），已成功批次不回滚
    }
    for (const item of batch) {
      const facts = parsed.byMessage.get(item.message_id) || [];
      for (const fact of facts) {
        stats.extracted += 1;
        const { row, reason, fork } = factToRow(fact, item, modelName);
        if (!row) {
          stats.invalid += 1;
          stats.dropReasons[reason] = (stats.dropReasons[reason] || 0) + 1;
          continue;
        }
        stats.fork[fork] += 1;
        if (row.confidence < 0.7) stats.belowThreshold += 1;
        stats.byField[row.field] = (stats.byField[row.field] || 0) + 1;
        rows.push(row);
      }
    }
  }

  // 幂等落库（INSERT OR IGNORE 首写优先）
  const r = upsertAgentFacts(db, rows, opts.extractedAt);
  stats.inserted = r.inserted;
  stats.duplicates = r.duplicates;
  stats.invalid += r.invalid.length;
  return { stats, rows };
}
