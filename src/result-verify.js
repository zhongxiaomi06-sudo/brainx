/** result-verify.js — specs/040 S3 结果校验层（C）：送达前用 B 层结构化必备项逐人硬校验。
 *
 * 位置：openmai-delivery worker 生成结果卡之前（结果已落库、卡片未发——校验只影响
 *  展示顺序与标注，不影响落库事实与 SENT 链路）。
 *
 * 判定规则（§7.2）：每条必备项（hard_requirements + exclusions）对每个候选人
 *   pass（履历明确满足）/ warn（明确冲突）/ unknown（证据不足）；
 *   任一 warn → 整体 warn（沉底 + 标注冲突条目），不剔除（避免空手而归）。
 *
 * 降级链（C4/C6/C7，本函数绝不抛错、绝不阻塞投递）：
 *   BRAINX_RESULT_VERIFY=0 → 跳过；无 B 层结构化判据（agent 路径/rules 兜底）→ 跳过；
 *   LLM 未配置 → 跳过；LLM 失败/超时/输出不合规 → 跳过 + skipped='llm_failed'
 *  （卡片侧仅对 llm_failed/error 显式标注「校验未执行」，其余静默跳过避免噪声）。
 */
import { chatJson, isLlmConfigured } from './llm.js';
import { readCompiledCriteria } from './criteria-compile.js';
import { extractOpenmaiCandidates } from './openmai-result.js';

export const RESULT_VERIFY_TIMEOUT_MS = Number(process.env.BRAINX_RESULT_VERIFY_TIMEOUT_MS) || 20_000;

export function isResultVerifyEnabled() {
  return process.env.BRAINX_RESULT_VERIFY !== '0';
}

const VERIFY_SYSTEM_PROMPT = `你是招聘候选人 JD 必备项校验器。输入是 JD 必备项列表（含客户排除项）与候选人摘要列表。
对每个候选人 × 每条必备项逐一判定：
- pass：候选人履历/评价明确满足该必备项，或不触碰该排除项
- warn：候选人履历与该必备项明确冲突（例：必备「忌讳仅有大厂经历」而候选人主要经历全是大厂）
- unknown：候选人摘要证据不足，无法判定
只输出一个 JSON 对象：
{"verdicts":[{"candidate_ref":"候选人编号原文","checks":[{"requirement":"必备项原文","verdict":"pass|warn|unknown"}]}]}
规则：每个候选人都必须出现且只出现一次；requirement 必须原样返回；不得编造摘要里没有的事实；不确定就 unknown。`;

/** LLM 判定输出归一化：candidate_ref → checks[]；缺失/畸形条目剔除。 */
function normalizeVerdictOutput(raw, candidates) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.verdicts) ? raw.verdicts : null;
  if (!list) return null;
  const byRef = new Map();
  for (const item of list) {
    const ref = String(item?.candidate_ref || '').trim();
    if (!ref || !Array.isArray(item?.checks)) continue;
    byRef.set(ref, item.checks
      .filter((c) => c && typeof c.requirement === 'string' && ['pass', 'warn', 'unknown'].includes(c.verdict))
      .map((c) => ({ requirement: c.requirement.slice(0, 80), verdict: c.verdict })));
  }
  // 至少覆盖一半候选人才可信（完全跑偏的输出按 llm_failed 处理）
  const covered = candidates.filter((c) => byRef.has(c.candidateRef)).length;
  if (covered < Math.ceil(candidates.length / 2)) return null;
  return byRef;
}

/** 聚合：候选人整体 verdict + 冲突条目列表。 */
export function aggregateVerdicts(candidates, checksByRef) {
  const verdicts = {};
  for (const candidate of candidates) {
    const checks = checksByRef.get(candidate.candidateRef) || [];
    const failed = checks.filter((c) => c.verdict === 'warn').map((c) => c.requirement);
    const hasPass = checks.some((c) => c.verdict === 'pass');
    verdicts[candidate.candidateRef] = {
      verdict: failed.length ? 'warn' : hasPass ? 'pass' : 'unknown',
      failed,
    };
  }
  return verdicts;
}

/** S3 主入口：校验一批候选人。永不抛错；skipped 字段说明跳过原因。 */
export async function verifyOpenmaiBatch(db, { projectId, resultText = null, candidates = null }, dependencies = {}) {
  const chat = dependencies.chatJson || chatJson;
  const llmConfigured = dependencies.isLlmConfigured || isLlmConfigured;
  try {
    if (!isResultVerifyEnabled()) return { skipped: 'disabled' };            // C6
    if (!llmConfigured()) return { skipped: 'llm_not_configured' };
    const compiled = readCompiledCriteria(db, projectId);
    if (!compiled) return { skipped: 'no_requirements' };                   // C4：agent 路径/rules 兜底
    const requirements = [...compiled.hard_requirements, ...compiled.exclusions]
      .filter(Boolean).slice(0, 8);
    if (!requirements.length) return { skipped: 'no_requirements' };
    const list = Array.isArray(candidates) && candidates.length
      ? candidates : extractOpenmaiCandidates(resultText);
    if (!list.length) return { skipped: 'no_candidates' };                  // C8：只校验有候选人的 done 批次

    const userPrompt = [
      'JD 必备项（逐条判定，含排除项）：',
      ...requirements.map((r, i) => `${i + 1}. ${r}`),
      '',
      '候选人摘要列表：',
      JSON.stringify(list.map((c) => ({
        candidate_ref: c.candidateRef, name: c.name, role: c.role,
        background: [c.experience, c.city, c.education].filter((x) => x && x !== '待核实').join(' · '),
        evaluation: c.evaluation,
      }))),
    ].join('\n');

    let checksByRef = null;
    try {
      const raw = await chat(VERIFY_SYSTEM_PROMPT, userPrompt, { timeout: RESULT_VERIFY_TIMEOUT_MS });
      checksByRef = normalizeVerdictOutput(raw, list);
    } catch { checksByRef = null; /* C7：LLM 失败 → 原序投递 */ }
    if (!checksByRef) return { skipped: 'llm_failed' };

    const verdicts = aggregateVerdicts(list, checksByRef);
    const passCount = list.filter((c) => verdicts[c.candidateRef].verdict === 'pass').length;
    const warnCount = list.filter((c) => verdicts[c.candidateRef].verdict === 'warn').length;
    return { verdicts, requirements, passCount, warnCount, total: list.length };
  } catch (error) {
    // C7：校验异常绝不阻塞投递链路
    return { skipped: 'error', error: String(error?.message || error).slice(0, 200) };
  }
}
