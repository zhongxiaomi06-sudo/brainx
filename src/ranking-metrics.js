/** Shared offline ranking metrics. Unknown labels stay unknown and keep position. */

export const RANKING_METRIC_VERSION = 'ranking-metrics-v2';

const gain = (label) => Math.pow(2, label) - 1;

function knownLabel(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0) throw new TypeError('label 必须是非负有限数字或 null');
  return value;
}

export function dcg(labels) {
  return labels.reduce((sum, value, index) => {
    const label = knownLabel(value);
    return label === null ? sum : sum + gain(label) / Math.log2(index + 2);
  }, 0);
}

/**
 * DCG follows the original predicted positions. IDCG uses every known label in
 * the evaluation group, so a valuable item below K still affects the ideal.
 */
export function ndcgAtK(items, k, labelOf = (item) => item.label) {
  const limit = Math.max(1, Number(k) || 1);
  const labels = items.map((item) => knownLabel(labelOf(item)));
  const known = labels.filter((label) => label !== null);
  if (!known.length) return null;

  const ideal = known.sort((a, b) => b - a).slice(0, limit);
  const denominator = dcg(ideal);
  if (denominator <= 0) return null;

  const predicted = labels.slice(0, limit);
  return dcg(predicted) / denominator;
}
