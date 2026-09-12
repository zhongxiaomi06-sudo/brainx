/** OpenMai 结构化候选与“需要补充职位信息”结果判定。 */
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
        candidateRefValid: SAFE_CANDIDATE_REF.test(rawRef),
        name: String(item?.name || `候选人${index + 1}`).slice(0, 60),
        role: String(item?.role || '当前岗位待核实').slice(0, 120),
        experience: String(item?.experience || '待核实').slice(0, 40),
        city: String(item?.city || '待核实').slice(0, 40),
        education: String(item?.education || '待核实').slice(0, 80),
        evaluation: String(item?.evaluation || '待顾问核验').slice(0, 300),
        score: String(item?.score || '—').slice(0, 20),
        resumeUrl: typeof item?.resume_url === 'string' ? item.resume_url : null,
        talentUrl: typeof item?.talent_url === 'string' ? item.talent_url : null,
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
      ? 'OpenMai 需要更具体的职位信息；请在工作台补充方向、职责、目标公司或关键经验后重新找人。'
      : hasMachineBlock && count < 6
        ? `OpenMai 本轮仅返回 ${count} 名结构化候选人，未达到首轮 6–10 人目标；已保留现有结果，请明确重试补充。`
        : null,
  };
}

/** OpenMai completions 会话状态跨调用污染的元回复特征（2026-09-09 实测两种形态：
 * 「我接上次进度：你在看职位 J5Z8J10…」「没有可恢复的上一轮运行上下文…历史任务只有…」）。
 * 特征：谈论会话/上下文/历史任务本身，而不是交付候选人。 */
const POLLUTION_PATTERNS = [
  /没有可恢复的.{0,12}上下文/,
  /上一轮运行上下文/,
  /(?:我)?接上次进度/,
  /(?:可见|现有)的(?:历史|过往)任务只有/,
  /会话列表为空/,
  /(?:历史|之前|此前)(?:会话|对话|任务).{0,16}(?:上下文|继续|接着)/,
];

export function looksLikeSessionPollution(value) {
  const text = String(value || '');
  if (!text.trim()) return false;
  if (CANDIDATE_BLOCK.test(text)) return false;
  if (/候选人/.test(text) && /\|/.test(text)) return false;
  return POLLUTION_PATTERNS.some((p) => p.test(text));
}
