const pipelineTerms: Record<string, string> = {
  sourcing: "寻访",
  recommendation: "推荐",
  screening: "筛选",
  interview: "面试",
  offer: "Offer",
  onboard: "入职",
  onboarding: "入职",
  closed: "已关闭",
};

export function displayPipeline(value: string | null | undefined) {
  if (!value || value === "UNKNOWN") return "待确认";
  return value.replace(/\b(sourcing|recommendation|screening|interview|offer|onboarding|onboard|closed)\b/gi,
    term => pipelineTerms[term.toLocaleLowerCase()] || term);
}

function cleanDirectionReason(value: string) {
  const detail = value.replace(/^方向匹配\s*[\d.]+\s*分[：:]\s*/, "").trim();
  const keywords = detail.match(/^与你画像关键词（(.+?)等）的重合度$/);
  if (keywords) return `画像关键词与 ${keywords[1]} 等方向重合`;
  if (/^与你历史主做项目文本的重合度/.test(detail)) return "与历史主做项目方向相近（个人画像尚未配置）";
  return detail;
}

export function recommendationSummary(reasons: string[]) {
  const direction = reasons.find(reason => /^方向匹配/.test(reason));
  const relation = reasons.find(reason => /^关系[：:]/.test(reason));
  const parts = [
    direction ? cleanDirectionReason(direction) : "",
    relation ? displayPipeline(relation.replace(/^关系[：:]\s*/, "")) : "",
  ].filter(Boolean);
  const summary = (parts.join("；") || reasons[0] || "").replace(/\s+/g, " ").trim();
  return Array.from(summary).length > 88 ? `${Array.from(summary).slice(0, 88).join("")}…` : summary;
}
