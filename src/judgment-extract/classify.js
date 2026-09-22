/** classify.js — 顾问判断抽取：规则层（纯函数，永远在）+ LLM 层（可选）。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 模式复刻 job-extract/classify.js：isJudgmentRelevant 先行砍 LLM 调用、
 * 每个命中字段必须带 evidence 原文片段、规则层保底（AI_JUDGMENT_EXTRACT_ENABLED 关闭时唯一路径）。
 * 本域语义重于职位事实，规则层故意保守：只抓"客户说…不接受/只要…"类显式句型，
 * 其余留给 LLM 层；无证据不编造（宁缺勿错）。
 */

const RELEVANT_KEYWORDS = [
  '客户说', '客户要求', '不接受', '只要', '必须', '不看', '不考虑',
  '否决', '拒了', '被拒', '因为', '太贵', '薪资', '学历', '异地', '背景',
  '经验不足', '超龄', '年纪', '稳定性', '跳槽太', '明确说',
];

/** 判断相关性分类（规则先行：未命中直接 skip_irrelevant，零 LLM 成本）。 */
export function isJudgmentRelevant(text) {
  if (!text) return false;
  return RELEVANT_KEYWORDS.some((k) => text.includes(k));
}

/** 显式句型："{对象}说/要求/明确说 … {不接受|不要|只要|必须|不看|不考虑} …"。 */
/** 显式句型："{对象}说/要求/明确说 … {不接受|不要|只要|必须|不看|不考虑} …"。
 * 逗号/句号都作终止符——宁可截断保守，不吞并后半句（宁缺勿错）。 */
const EXPLICIT_RE =
  /([\u4e00-\u9fa5A-Za-z0-9]{2,16}?)(?:说|要求|明确说|反馈)[:：，,\s]*[^。；;！!？?\n]{0,60}?(不接受|不要|只要|必须|只看|不看|不考虑)([^。；;！!？?，,\n]{1,60})/;

const KIND_BY_VERB = [
  [/(?:不接受|不要|不看|不考虑)/, 'CONSTRAINT'],
  [/(?:只要|必须|只看)/, 'PREFERENCE'],
];

function guessSubjectType(ref) {
  if (/公司|集团|科技|客户/.test(ref)) return 'CLIENT_COMPANY';
  if (/工程师|经理|总监|负责人|岗位|职位/.test(ref)) return 'PROJECT';
  return 'GENERAL';
}

/**
 * 规则层抽取。返回与 judgmentDraftSchema 同构的字段对象；
 * 未命中显式句型时 statement=null（消费层 skip，不落草稿）。
 */
export function extractJudgmentRules(text) {
  const fields = { subject: null, kind: null, statement: null, confidence: 'low' };
  if (!text) return fields;
  const m = text.match(EXPLICIT_RE);
  if (!m) return fields;
  const [, subjectRef, verb, content] = m;
  const kind = KIND_BY_VERB.find(([re]) => re.test(verb))?.[1];
  if (!kind) return fields;
  const evidence = m[0].trim().slice(0, 200);
  fields.subject = { type: guessSubjectType(subjectRef), ref: subjectRef, evidence };
  fields.kind = kind;
  fields.statement = { text: `${verb}${content}`.trim().slice(0, 120), evidence };
  fields.confidence = 'high'; // 显式句型命中：规则层高置信
  return fields;
}

/** LLM 抽取（AI_JUDGMENT_EXTRACT_ENABLED=1 且 llm 已配置时由调用方选用）。
 * 纪律：只抽文本里明确表达的判断并回带原文证据子串；没有一律 null（宁缺勿错）。
 * 返回与 extractJudgmentRules 同形。 */
export async function extractJudgmentLlm(text, chatName = null) {
  const { chatJson } = await import('../llm.js');
  const system = `你是猎头业务群消息的判断抽取器。抽取顾问在对话中表达的业务判断，只输出 JSON。
判断类型 kind：PREFERENCE=偏好（只要/更倾向）、CONSTRAINT=硬性要求（不接受/不看/必须）、
EXCEPTION=例外规则（一般…但这次/除了）、REJECTION=否决原因（因为…拒了/否了）、EVALUATION=对人或候选人的评价。
规则：只抽取原文中明确表达的判断；subject.ref 与 statement.text 必须有 evidence（原文连续子串，≤60字）；
没有判断时 subject/kind/statement 全部输出 null；禁止推测、补全或泛化原文没有的意思；
statement.text 用≤120字归一化陈述，不得偏离 evidence 的含义。`;
  const user = `群消息（群名：${chatName || '未知'}）：
---
${String(text).slice(0, 4000)}
---
输出 JSON：{"subject":{"type":"CLIENT_COMPANY|PROJECT|CANDIDATE|GENERAL","ref":"…","evidence":"…"}|null,"kind":"PREFERENCE|CONSTRAINT|EXCEPTION|REJECTION|EVALUATION"|null,"statement":{"text":"…","evidence":"…"}|null}`;
  const out = await chatJson(system, user);
  return mapJudgmentLlmFields(out, String(text));
}

/** LLM 输出 → 草稿字段统一映射 + evidence 原文重合校验（重合=high，否则 medium；
 * evidence 不在原文中出现的字段一律丢弃——宁缺勿错），调用方 schema 校验兜底。 */
export function mapJudgmentLlmFields(out, src) {
  const fields = { subject: null, kind: null, statement: null, confidence: 'low' };
  if (!out || typeof out !== 'object') return fields;
  const evOk = (ev) => {
    const e = String(ev || '').slice(0, 200).trim();
    if (!e) return { ok: false, evidence: null, confidence: 'low' };
    const probe = e.slice(0, Math.min(12, e.length));
    return src.includes(probe)
      ? { ok: true, evidence: e, confidence: 'high' }
      : { ok: false, evidence: null, confidence: 'low' }; // 无原文锚定=丢弃
  };
  const st = mapStatement(out.statement, src, evOk);
  if (!st) return fields; // 无有效 statement = 本条无判断
  fields.statement = st.value;
  const kind = String(out.kind || '').toUpperCase();
  fields.kind = ['PREFERENCE', 'CONSTRAINT', 'EXCEPTION', 'REJECTION', 'EVALUATION'].includes(kind)
    ? kind : null;
  if (!fields.kind) return { subject: null, kind: null, statement: null, confidence: 'low' };
  fields.confidence = st.confidence;
  if (out.subject && typeof out.subject === 'object') {
    const type = String(out.subject.type || '').toUpperCase();
    const ref = String(out.subject.ref || '').trim().slice(0, 60);
    const ev = evOk(out.subject.evidence);
    if (['CLIENT_COMPANY', 'PROJECT', 'CANDIDATE', 'GENERAL'].includes(type) && ref && ev.ok) {
      fields.subject = { type, ref, evidence: ev.evidence };
      if (ev.confidence === 'high' && fields.confidence !== 'high') fields.confidence = 'medium';
    }
  }
  return fields;
}

function mapStatement(v, _src, evOk) {
  if (!v || typeof v !== 'object') return null;
  const text = String(v.text || '').trim().slice(0, 120);
  if (!text) return null;
  const ev = evOk(v.evidence);
  if (!ev.ok) return null;
  return { value: { text, evidence: ev.evidence }, confidence: ev.confidence };
}
