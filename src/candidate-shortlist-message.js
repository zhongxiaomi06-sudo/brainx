/** Deterministic Feishu-safe text projection; no model is needed to render it. */
import { parseCandidateMatchBundle } from './talent-contracts.js';

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export function formatCandidateShortlistMessage(rawBundle, { jobName = '当前职位' } = {}) {
  const bundle = parseCandidateMatchBundle(rawBundle);
  const context = bundle.job_context;
  const requirement = [context?.experience_requirement, context?.education_requirement]
    .filter(Boolean).map(oneLine).join('；');
  const lines = [`【候选人判断｜${oneLine(jobName).slice(0, 80)}】`,
    `岗位画像：${oneLine(context?.summary) || '职位要求待补充'}${requirement ? `；${requirement}` : ''}`,
    '结论：先看可验证的交付证据，再核实基础人事、年龄和到岗等会改变判断的硬条件。'];
  if (!bundle.items.length) return [...lines, '当前没有可展示的已授权候选人。'].join('\n');
  for (const item of bundle.items) {
    const current = item.profile.recent_experiences.find((entry) => entry.is_current)
      || item.profile.recent_experiences[0];
    const evidence = item.profile.recent_experiences.find((entry) => entry.summary)?.summary;
    const pending = [...item.gaps, ...item.risks, ...item.unknowns];
    lines.push('', `${item.rank}. ${item.display_name_masked}｜${item.rank === 1 ? '优先看' : '对比看'}｜实力 ${item.strength.score} / 匹配 ${item.job_fit.score}`,
      `履历：${current ? `${oneLine(current.company)} · ${oneLine(current.title)}` : oneLine(item.strength.summary)}${item.profile.current_city ? ` · ${oneLine(item.profile.current_city)}` : ''}`,
      `有用证据：${oneLine(evidence).slice(0, 180) || oneLine(item.strength.summary)}`,
      `最大待核实：${oneLine(pending[0]) || '暂无显著待确认项'}`);
  }
  lines.push('', '口径：现有 reloop 排序，仅做结构化证据解释；不含手机号、邮箱、完整姓名或简历原文。');
  return lines.join('\n');
}
