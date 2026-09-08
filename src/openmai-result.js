/** OpenMai 结构化候选与“需要补充岗位画像”结果判定。 */
const CANDIDATE_BLOCK = /<!--\s*BRAINX_CANDIDATES_V1\s*([\s\S]*?)-->/;
const SAFE_CANDIDATE_REF = /^[A-Za-z0-9:_-]{1,100}$/;
const CLARIFICATION_ONLY = /(?:请选择|请补充|补充).{0,20}(?:岗位|职位|画像|方向|条件)|(?:岗位|职位).{0,12}(?:不明确|信息不足)/;

export function extractOpenmaiCandidates(value) {
  const match = String(value || '').match(CANDIDATE_BLOCK);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed?.candidates)) return [];
    return parsed.candidates.slice(0, 10).map((item, index) => {
      const rawRef = String(item?.candidate_ref || '');
      return {
        candidateRef: SAFE_CANDIDATE_REF.test(rawRef) ? rawRef : `candidate-${index + 1}`,
        name: String(item?.name || `候选人${index + 1}`).slice(0, 60),
        evaluation: String(item?.evaluation || '待顾问核验').slice(0, 300),
        resumeUrl: typeof item?.resume_url === 'string' ? item.resume_url : null,
      };
    });
  } catch { return []; }
}

export function assessOpenmaiCandidateBatch(value) {
  const text = String(value || '').trim();
  const hasMachineBlock = CANDIDATE_BLOCK.test(text);
  const count = extractOpenmaiCandidates(text).length;
  const needsInput = !hasMachineBlock && text.length <= 300 && CLARIFICATION_ONLY.test(text);
  return {
    count,
    hasMachineBlock,
    needsInput,
    complete: needsInput ? false : !hasMachineBlock || count >= 6,
    message: needsInput
      ? 'OpenMai 需要更具体的岗位画像；请在工作台补充方向、职责、目标公司或关键经验后重新找人。'
      : hasMachineBlock && count < 6
        ? `OpenMai 本轮仅返回 ${count} 名结构化候选人，未达到首轮 6–10 人目标；已保留现有结果，请明确重试补充。`
        : null,
  };
}
