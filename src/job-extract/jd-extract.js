/** jd-extract.js — E2-JD：顾问私聊整段 JD 的 LLM 结构化抽取（specs/005）。
 *
 * 纪律与 classify.extractLlm 同一红线：只抽 JD 原文明确存在的字段并回带 evidence
 * 原文子串；不存在的输出 null（宁缺勿错）。输出经 mapLlmFields 统一映射为
 * jobFactsDraftSchema 同形字段；salary/requirements 无权威列，仅随 extra 存档
 * 于草稿 raw_json 并回显，不得进权威表。
 * 超时 8s：对齐 openclaw 插件 10s 请求硬上限（8s + 落库 < 10s），超时由调用方
 * 降级规则层（p2p-submit.extractFields）。
 */
import { chatJson } from '../llm.js';

import { mapLlmFields } from './classify.js';

const JD_MAX_INPUT_CHARS = 4000;

export async function extractJdFields(text) {
  const system = `你是猎头业务的结构化 JD 抽取器。从整段 JD 原文中抽取职位事实，只输出 JSON。
规则：只抽取 JD 原文中明确存在的信息；每个字段必须给出 evidence（原文中连续子串，≤40字）；
不存在的字段输出 null；禁止推测、补全或翻译公司名；
salary（薪资）与 requirements（任职要求要点，字符串数组，最多 5 条，只抄原文）仅作存档参考。`;
  const user = `JD 原文：
---
${String(text).slice(0, JD_MAX_INPUT_CHARS)}
---
输出 JSON（字段值 null 或 {"text":"…","evidence":"…"}）：
{"company":{"text":"…","evidence":"…"}|null,"role":{…}|null,"city":{…}|null,"pipeline":{"text":"推荐/面试/Offer/入职等阶段描述","evidence":"…"}|null,"hc":{"text":"数字","evidence":"…"}|null,"active_state":{"text":"OPEN或CLOSED","evidence":"…"}|null,"salary":{"text":"…","evidence":"…"}|null,"requirements":["…"]|null}`;
  const out = await chatJson(system, user, { timeout: 8000 });
  const extra = {
    salary: out?.salary && typeof out.salary === 'object' && typeof out.salary.text === 'string'
      ? { text: out.salary.text.slice(0, 120), evidence: String(out.salary.evidence || '').slice(0, 200) || null }
      : null,
    requirements: Array.isArray(out?.requirements)
      ? out.requirements.filter((r) => typeof r === 'string' && r.trim()).slice(0, 5).map((r) => r.slice(0, 200))
      : null,
  };
  return { fields: mapLlmFields(out, String(text)), extra };
}
