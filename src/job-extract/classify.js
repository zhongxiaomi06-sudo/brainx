/** classify.js — E1 规则层分类与抽取（纯函数，零成本，永远在）。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4-§5；
 * 机制来源：ai-delegator「先分类后抽取」（isJobRelevant 先行砍 LLM 调用）、
 * langextract「原文锚定」（每个命中字段必须带 evidence 原文片段）、
 * hiring-agent「规则层保底」（AI_JOB_EXTRACT_ENABLED 关闭时唯一路径）。
 * 全部正则保守设计：无证据不编造（宁缺勿错）。
 */

const RELEVANT_KEYWORDS = [
  '招', '岗位', '职位', 'offer', 'Offer', 'OFFER', '面试', '简历', '候选人',
  'HC', 'hc', '入职', 'JD', 'jd', 'base', 'Base', 'BASE', '一面', '二面', '终面',
];

const CITIES =
  '北京|上海|深圳|广州|杭州|成都|武汉|南京|西安|苏州|长沙|重庆|天津|郑州|青岛|合肥|厦门|福州|济南|大连|宁波|无锡|远程|Remote|remote';

const COMPANY_SUFFIX =
  '(?:信息技术|网络科技有限公司|网络科技|科技有限公司|科技公司|科技|集团|有限公司|智能|数据|生物|医疗)';

const ROLE_SUFFIX =
  '(?:工程师|开发|产品经理|设计师|运营|顾问|销售|专员|经理|总监|负责人|实习生|专家|架构师)';

/** Offer-群名解析（启发式）：Offer-{团队}-{候选人}-{岗位}；团队可含多个 - 段。 */
export function parseOfferGroupName(name) {
  if (!name || !name.startsWith('Offer-')) return null;
  const parts = name.slice('Offer-'.length).split('-').filter(Boolean);
  if (parts.length < 2) return null;
  return {
    team: parts.slice(0, -2).join('-'),
    candidate: parts.at(-2),
    role: parts.at(-1),
  };
}

/** 职位相关性分类（规则先行：未命中直接 skip_irrelevant，零 LLM 成本）。 */
export function isJobRelevant(text) {
  if (!text) return false;
  return RELEVANT_KEYWORDS.some((k) => text.includes(k));
}

/** 命中字段统一形态：{ text|number|state|stage, evidence, confidence:'high' }。 */
const hit = (value, evidence) => ({ ...value, evidence, confidence: 'high' });
const UNKNOWN_STATE = { state: 'UNKNOWN', evidence: null, confidence: 'low' };

/** 状态关键词 → active_state（按优先级首个命中；先判终态再判活跃态）。 */
const STATE_RULES = [
  { state: 'COMPLETED', re: /(?:接了\s*offer|接受\s*offer|已入职|入职了|onboarded)/i },
  { state: 'CLOSED', re: /(?:关闭|停招|不招了|取消招聘|冻结招聘)/ },
  { state: 'ON_HOLD', re: /(?:暂停|hold|缓一缓|先放一放)/i },
  { state: 'COOLING', re: /(?:冷却|暂缓|过段时间再说)/ },
  { state: 'OPEN', re: /(?:急招|在招|开放|刚开|招聘中|要人)/ },
];

const PIPELINE_RULES = [
  { stage: 'ONBOARD', re: /(?:入职|onboard)/i },
  { stage: 'OFFER', re: /offer/i },
  { stage: 'INTERVIEW', re: /(?:一面|二面|三面|终面|约面|面试)/ },
  { stage: 'SCREENING', re: /(?:初筛|电话筛|简历筛选)/ },
  { stage: 'SOURCING', re: /(?:找人|寻访|sourcing)/i },
];

/**
 * 规则层抽取。返回与 jobFactsDraftSchema 字段同构的对象；
 * 无证据字段为 null（company/role/city/pipeline/hc）或 UNKNOWN 兜底（active_state）。
 * @param {string} text 消息正文原文
 * @param {string|null} [_chatName] 群名（事件里没有；register 时可补充，E1 不参与）
 */
/** E2 LLM 抽取（AI_JOB_EXTRACT_ENABLED=1 且 llm 已配置时由调用方选用）。
 * 纪律：只抽文本里存在的字段并回带原文证据子串；没有的一律 null（宁缺勿错，
 * 与规则层同一纪律）。返回与 extractRules 同形：{field: {text, evidence}|null}。 */
export async function extractLlm(text, chatName = null) {
  const { chatJson } = await import('../llm.js');
  const system = `你是猎头业务消息的事实抽取器。从群消息中抽取职位事实，只输出 JSON。
规则：只抽取消息原文中明确存在的信息；每个字段必须给出 evidence（原文中连续子串，≤40字）；
不存在的字段输出 null；禁止推测、补全或翻译公司名。`;
  const user = `群消息（群名：${chatName || '未知'}）：
---
${String(text).slice(0, 4000)}
---
输出 JSON（null 或字符串）：{"company":{"text":"…","evidence":"…"}|null,"role":{…}|null,"city":{…}|null,"pipeline":{"text":"推荐/面试/Offer/入职等阶段描述","evidence":"…"}|null,"hc":{"text":"数字","evidence":"…"}|null,"active_state":{"text":"OPEN或CLOSED","evidence":"…"}|null}`;
  const out = await chatJson(system, user);
  // 与规则层统一形态（{text, evidence, confidence}）：hc/active_state 是结构化字段，
  // pipeline 用 {stage}，confidence 按 evidence 与原文重合度给（重合=high，否则 medium）。
  const src = String(text);
  const field = (v, key = 'text') => {
    if (!v || typeof v !== 'object') return null;
    const val = typeof v.text === 'string' ? v.text.trim() : '';
    if (!val) return null;
    const evidence = String(v.evidence || '').slice(0, 200);
    const confidence = evidence && src.includes(evidence.slice(0, Math.min(12, evidence.length)))
      ? 'high' : 'medium';
    return { [key]: key === 'hc' ? (Number(val.match(/\d+/)?.[0]) || val) : val.slice(0, 120),
             evidence: evidence || null, confidence };
  };
  const stateField = (v) => {
    if (!v || typeof v !== 'object') return null;
    const val = String(v.text || '').toUpperCase();
    if (!/OPEN|CLOSED/.test(val)) return null;
    return { state: val.includes('CLOSED') ? 'CLOSED' : 'OPEN',
             evidence: String(v.evidence || '').slice(0, 200) || null, confidence: 'medium' };
  };
  const hcField = (v) => {
    if (!v || typeof v !== 'object') return null;
    const n = Number(String(v.text || '').match(/\d+/)?.[0]);
    if (!Number.isInteger(n) || n <= 0 || n > 999) return null;
    return { number: n, evidence: String(v.evidence || '').slice(0, 200) || null, confidence: 'medium' };
  };
  const STAGE_MAP = [
    [/offer|Offer|OFFER/i, 'OFFER'], [/入职|onboard/i, 'ONBOARD'],
    [/面试|一面|二面|三面|终面|interview/i, 'INTERVIEW'],
    [/筛选|screen/i, 'SCREENING'], [/推荐|寻访|sourcing/i, 'SOURCING'],
    [/关闭|暂停|取消/i, 'CLOSED'],
  ];
  const pipelineField = (v) => {
    if (!v || typeof v !== 'object') return null;
    const val = String(v.text || '');
    if (!val.trim()) return null;
    const stage = STAGE_MAP.find(([re]) => re.test(val))?.[1];
    if (!stage) return null;
    return { stage, evidence: String(v.evidence || '').slice(0, 200) || null, confidence: 'medium' };
  };
  return {
    company: field(out.company), role: field(out.role), city: field(out.city),
    pipeline: pipelineField(out.pipeline), hc: hcField(out.hc),
    active_state: stateField(out.active_state),
  };
}

export function extractRules(text, _chatName = null) {
  const fields = {
    company: null,
    role: null,
    city: null,
    pipeline: null,
    hc: null,
    active_state: UNKNOWN_STATE,
  };
  if (!text) return fields;

  const company = text.match(new RegExp(`([\\u4e00-\\u9fa5A-Za-z0-9]{2,16}${COMPANY_SUFFIX})`));
  if (company) fields.company = hit({ text: company[1] }, company[1]);

  const role = text.match(new RegExp(`(?:急招|招聘|招|寻|找)\\s*([\\u4e00-\\u9fa5A-Za-z0-9/]{2,20}?${ROLE_SUFFIX})`));
  if (role) fields.role = hit({ text: role[1] }, role[0]);

  const city = text.match(new RegExp(`(?:base|Base|BASE|坐标|在)\\s*[:：]?\\s*(${CITIES})`));
  if (city) fields.city = hit({ text: city[1] }, city[0].trim());

  for (const { stage, re } of PIPELINE_RULES) {
    const m = text.match(re);
    if (m) {
      fields.pipeline = hit({ stage }, m[0]);
      break;
    }
  }

  const hc =
    text.match(/(?:hc|HC|headcount|名额)\s*[:：]?\s*(\d{1,3})/) ??
    text.match(/要\s*(\d{1,3})\s*个?人/);
  if (hc) fields.hc = hit({ number: Number(hc[1]) }, hc[0].trim());

  for (const { state, re } of STATE_RULES) {
    const m = text.match(re);
    if (m) {
      fields.active_state = hit({ state }, m[0]);
      break;
    }
  }
  return fields;
}
