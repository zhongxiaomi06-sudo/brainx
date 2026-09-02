/** Deterministic Feishu-safe text projection; no model is needed to render it. */
import { parseCandidateMatchBundle } from './talent-contracts.js';

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();

export function formatCandidateShortlistMessage(rawBundle, { jobName = '当前职位' } = {}) {
  const bundle = parseCandidateMatchBundle(rawBundle);
  const lines = [`【候选人推荐｜${oneLine(jobName).slice(0, 80)}】`,
    '口径：现有 reloop 推荐的结构化转换结果，不是 BrainX 新算法重排。'];
  if (!bundle.items.length) return [...lines, '当前没有可展示的已授权候选人。'].join('\n');
  for (const item of bundle.items) {
    const pending = [...item.gaps, ...item.unknowns,
      ...item.hard_conditions.filter((entry) => entry.result === 'UNKNOWN')
        .map((entry) => `${entry.criterion}待核实`)];
    lines.push('', `${item.rank}. ${item.display_name_masked}｜实力 ${item.strength.score}｜匹配 ${item.job_fit.score}`,
      `推荐理由：${oneLine(item.strength.summary)}；${oneLine(item.job_fit.summary)}`,
      `优先确认：${pending.slice(0, 2).map(oneLine).join('；') || '暂无显著待确认项'}`);
  }
  lines.push('', '隐私说明：本消息不含手机号、邮箱、完整姓名或简历原文。');
  return lines.join('\n');
}
