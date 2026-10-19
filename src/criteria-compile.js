/** criteria-compile.js — specs/040 S2 判据编译层（B）：触发前把 JD 编译成结构化判据。
 *
 * 咪 2026-10-19 16:47 拍板 B+C 组合。设计原则：agent 路径质量高的本质是「对话经过
 * 了 agent 的理解整理」——本层给自动路径装上同一个整理层；S1 规则判据既是输入也是兜底。
 *
 * 流程：job_facts（notes 权威列 → raw_json.notes 兜底）+ 基础字段
 *   → S1 sanitize 剥歧视条件 → LLM（chatJson，temperature=0）编译 → 结构化 schema
 *   → 出参双重 sanitize（prompt 禁令 + 正则兜底复检）
 *   → 拼自然语言判据（≤1200 字，search_brief 2000 上限内留余量）→ 传引擎
 *
 * 降级链（判据永不因本层失败而阻塞触发）：
 *   BRAINX_CRITERIA_LLM=0（kill switch）→ S1 规则判据；
 *   LLM 未配置 / notes 为空 / 调用失败 / 超时（10s）/ 输出不合 schema → S1 规则判据。
 *
 * 追溯：结果（含 criteria_source='llm_compiled'|'rules' 与结构化 JSON）记
 * workflow_event_log（event_type='criteria.compiled'，idem_key 按 project+round 幂等），
 * S3 校验层经 readCompiledCriteria 读取；事后可统计两种来源的转化率差异。
 */
import { chatJson, isLlmConfigured } from './llm.js';
import { buildAutoSearchCriteria, jobNotesText, sanitizeJdNotes } from './auto-search.js';
import { emitEvent } from './hub/emit.js';

export const CRITERIA_COMPILE_TIMEOUT_MS = Number(process.env.BRAINX_CRITERIA_LLM_TIMEOUT_MS) || 10_000;

const SYSTEM_PROMPT = `你是招聘搜索判据编译器。把 JD 原文编译成结构化人才搜索判据 JSON，供人才搜索引擎理解执行。
只输出一个 JSON 对象，schema 如下：
{
  "role_focus": "岗位方向一句话，含职责语义（例：商务BD-广告主资源（销售向：客户开拓/谈判/回款/销售指标））",
  "hard_requirements": ["硬性必备项，每条一句话，可含客户禁忌（例：忌讳仅有大厂经验缺乏落地能力）"],
  "preferences": ["偏好项，非必备"],
  "exclusions": ["明确排除项（例：纯 PM/纯产品视角；采购/IP引入背景不能替代销售）"],
  "years_range": "年限区间字符串如 3-8，JD 未明确则填 null",
  "city_override": "工作地点城市名单个城市，JD/客户画像均无明确工作地点则填 null",
  "city_source": "city_override 的来源：'xiaomai_profile'（小麦同步画像/客户画像块）| 'jd_text'（JD 原文）| null"
}
编译规则：
1. 只从 JD 原文与画像块提取真实信息，不得编造 JD 没有的要求；无法判断的字段填 null，不硬造。
2. 「小麦同步画像」/「客户画像」块是客户一手意图，优先级最高；与职位基础字段冲突时以画像为准，并记 city_source='xiaomai_profile'。
3. 严禁输出年龄、性别、健康、婚育、户籍、地域等歧视性条件；JD 里出现也必须忽略，不进任何字段。
4. hard_requirements ≤5 条、preferences ≤5 条、exclusions ≤5 条，每条 ≤60 字，简体中文。`;

/** 编译输出归一化 + 出参 sanitize（双重 sanitize 的出参侧，LLM 约束不可信）。 */
function normalizeCompiled(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cleanList = (value) => {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => sanitizeJdNotes(String(item ?? '')) || '')
      .filter(Boolean)
      .map((s) => s.slice(0, 60))
      .slice(0, 5);
  };
  const roleFocus = sanitizeJdNotes(String(raw.role_focus ?? ''))?.slice(0, 120) || '';
  const years = /^[0-9]{1,2}\s*[-–~至]?\s*[0-9]{0,2}$/.test(String(raw.years_range ?? '').trim())
    ? String(raw.years_range).trim().replace(/\s+/g, '') : null;
  const city = String(raw.city_override ?? '').trim().slice(0, 20) || null;
  const citySource = ['xiaomai_profile', 'jd_text'].includes(raw.city_source) ? raw.city_source : null;
  const hard = cleanList(raw.hard_requirements);
  const prefer = cleanList(raw.preferences);
  const exclude = cleanList(raw.exclusions);
  if (!roleFocus && !hard.length && !prefer.length && !exclude.length) return null;
  return {
    role_focus: roleFocus,
    hard_requirements: hard,
    preferences: prefer,
    exclusions: exclude,
    years_range: years,
    city_override: city,
    city_source: city ? citySource : null,
  };
}

/** 结构化判据 → 自然语言判据文本（引擎接口是文本 criteria）。总长 ≤1200 字。 */
export function buildCriteriaText(compiled, job) {
  const parts = [];
  if (compiled.role_focus) parts.push(compiled.role_focus);
  // 小麦画像优先原则：city_override 优先于 job.city
  const city = compiled.city_override || job?.city;
  if (city) parts.push(city);
  if (job?.hc) parts.push(`${job.hc}人`);
  if (job?.company) parts.push(`（招聘方：${job.company}）`);
  if (compiled.years_range) parts.push(`${compiled.years_range} 年工作经验`);
  else parts.push('3-5 年工作经验');
  if (compiled.hard_requirements.length) parts.push(`必备：${compiled.hard_requirements.join('；')}`);
  if (compiled.preferences.length) parts.push(`优先：${compiled.preferences.join('；')}`);
  if (compiled.exclusions.length) parts.push(`排除：${compiled.exclusions.join('；')}`);
  return parts.join('，').slice(0, 1200);
}

function recordCompiled(db, { projectId, round, criteria, source, compiled, fallbackReason = null }) {
  try {
    emitEvent(db, {
      event_type: 'criteria.compiled',
      idem_key: `criteria:compiled:${projectId}:r${round}`,
      actor: 'system:criteria-compile',
      case_id: projectId,
      payload: {
        project_id: projectId, round, criteria_source: source,
        criteria_text: String(criteria || '').slice(0, 2000), compiled,
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
      },
      evidence_refs: [{ table: 'job_facts', id: String(projectId) }],
    });
  } catch { /* 留痕失败不阻塞触发（判据本体已生成） */ }
}

/** 触发前编译判据（specs/040 S2 主入口）。
 *  返回 { criteria, criteria_source: 'llm_compiled'|'rules', compiled }。
 *  绝不抛错：任何失败路径都落回 S1 规则判据（B5/B8）。 */
export async function compileSearchCriteria(db, job, { projectId, round = 1, dependencies = {} } = {}) {
  const chat = dependencies.chatJson || chatJson;
  const llmConfigured = dependencies.isLlmConfigured || isLlmConfigured;
  const rulesCriteria = buildAutoSearchCriteria(job);
  const rulesOut = (fallbackReason) => {
    recordCompiled(db, { projectId, round, criteria: rulesCriteria, source: 'rules', compiled: null, fallbackReason });
    return { criteria: rulesCriteria, criteria_source: 'rules', compiled: null };
  };

  // B7 kill switch / LLM 未配置 → 全程无 LLM 调用，直接规则判据
  if (process.env.BRAINX_CRITERIA_LLM === '0' || !llmConfigured()) {
    return rulesOut(process.env.BRAINX_CRITERIA_LLM === '0' ? 'kill_switch' : 'llm_not_configured');
  }
  // B6 notes 为空 → 无可编译素材，省一次调用
  const notes = sanitizeJdNotes(jobNotesText(job));
  if (!notes) return rulesOut('no_notes');

  const userPrompt = [
    `职位基础字段：role=${job?.role || '未填'}；city=${job?.city || '未填'}；hc=${job?.hc ?? '未填'}；company=${job?.company || '未填'}`,
    `pipeline（可能为空）：${job?.pipeline || '无'}`,
    'JD 原文与客户画像（已预剥离歧视性条件）：',
    notes,
  ].join('\n');

  let compiled = null;
  try {
    const raw = await chat(SYSTEM_PROMPT, userPrompt, { timeout: CRITERIA_COMPILE_TIMEOUT_MS });
    compiled = normalizeCompiled(raw);
  } catch { compiled = null; /* B5 超时/B8 解析失败 → 规则兜底 */ }
  if (!compiled) return rulesOut('llm_failed_or_invalid');

  const criteria = buildCriteriaText(compiled, job);
  if (!criteria) return rulesOut('empty_compiled_text');
  recordCompiled(db, { projectId, round, criteria, source: 'llm_compiled', compiled });
  return { criteria, criteria_source: 'llm_compiled', compiled };
}

/** S3 读取入口：取项目最新一次编译的结构化判据（无或损坏返回 null）。 */
export function readCompiledCriteria(db, projectId) {
  const row = db.prepare(`SELECT payload FROM workflow_event_log
    WHERE event_type='criteria.compiled' AND case_id=?
    ORDER BY occurred_at DESC, event_id DESC LIMIT 1`).get(String(projectId || ''));
  if (!row?.payload) return null;
  try {
    const parsed = JSON.parse(row.payload);
    const compiled = parsed?.compiled;
    if (!compiled || typeof compiled !== 'object') return null;
    return {
      criteria_source: parsed.criteria_source || 'rules',
      hard_requirements: Array.isArray(compiled.hard_requirements) ? compiled.hard_requirements : [],
      exclusions: Array.isArray(compiled.exclusions) ? compiled.exclusions : [],
      preferences: Array.isArray(compiled.preferences) ? compiled.preferences : [],
      years_range: compiled.years_range || null,
      city_override: compiled.city_override || null,
    };
  } catch { return null; }
}
