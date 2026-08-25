import { chatJson } from './llm.js';
import { normalizeWeights } from './scorer.js';

export const WEIGHT_DIMENSIONS = [
  'direction', 'activity', 'similarity', 'capacity', 'outcomes', 'exploration',
];

export class WeightSuggestionError extends Error {
  constructor(message, code = 'LLM_INVALID_RESPONSE') {
    super(message);
    this.code = code;
  }
}

const SYSTEM_PROMPT = `你是 BrainX 岗位推荐权重助手。只输出 JSON 对象：
{"weights":{"direction":数字,"activity":数字,"similarity":数字,"capacity":数字,"outcomes":数字,"exploration":数字},"reply":"一句简洁中文解释"}
六个权重必须是 0-100 的非负数字。维度含义：direction=职位方向匹配，activity=项目活跃度与 Pipeline，similarity=历史项目相似度，capacity=当前承接容量，outcomes=历史行为与交付结果，exploration=探索额度。不要输出职位事实，不要声称已经保存或执行推荐。`;

function percentages(weights) {
  const raw = WEIGHT_DIMENSIONS.map((dim) => Number(weights[dim]) * 100);
  const values = raw.map(Math.floor);
  let remainder = 100 - values.reduce((sum, value) => sum + value, 0);
  const order = raw.map((value, index) => ({ index, fraction: value - values[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let i = 0; i < remainder; i++) values[order[i % order.length].index] += 1;
  return Object.fromEntries(WEIGHT_DIMENSIONS.map((dim, index) => [dim, values[index]]));
}

export async function suggestWeights(preference, { chatJsonFn = chatJson, signal } = {}) {
  const text = String(preference || '').trim();
  if (!text || text.length > 1000) {
    throw new WeightSuggestionError('偏好不能为空且不能超过 1000 字', 'INVALID_PREFERENCE');
  }
  const result = await chatJsonFn(SYSTEM_PROMPT, text, { signal });
  const normalized = normalizeWeights(result?.weights);
  if (!normalized.ok || !normalized.weights) {
    throw new WeightSuggestionError(normalized.error || '模型没有返回有效六维权重');
  }
  const reply = String(result?.reply || '已生成六维权重建议，请确认后保存。').trim().slice(0, 300);
  return { weights: percentages(normalized.weights), reply };
}
