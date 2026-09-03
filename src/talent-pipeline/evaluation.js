const gain = relevance => (2 ** Number(relevance || 0)) - 1;

function dcg(items, labels, k) {
  return items.slice(0, k).reduce((sum, id, index) => sum + gain(labels.get(id)) / Math.log2(index + 2), 0);
}

export function evaluateRankingSet(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('EVALUATION_SET_EMPTY');
  const results = cases.map(item => {
    const labels = new Map(Object.entries(item.labels || {}).map(([id, value]) => [id, Number(value)]));
    const relevant = [...labels].filter(([, value]) => value > 0).map(([id]) => id);
    const top20 = item.shadow_order.slice(0, 20);
    const recall = relevant.length ? relevant.filter(id => top20.includes(id)).length / relevant.length : 1;
    const ideal = [...labels].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    const idealDcg = dcg(ideal, labels, 10);
    const assessed = top20.filter(id => typeof item.hard_condition_pass?.[id] === 'boolean');
    const falsePositives = assessed.filter(id => item.hard_condition_pass[id] === false).length;
    const covered = item.shadow_order.slice(0, 10)
      .map(id => item.evidence_coverage?.[id]).filter(value => Number.isFinite(value));
    return { case_id: item.case_id, recall_at_20: recall,
      ndcg_at_10: idealDcg ? dcg(item.shadow_order, labels, 10) / idealDcg : 1,
      hard_condition_false_positive_rate: assessed.length ? falsePositives / assessed.length : null,
      evidence_coverage: covered.length ? covered.reduce((sum, value) => sum + value, 0) / covered.length : null };
  });
  const mean = key => {
    const values = results.map(item => item[key]).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  };
  return Object.freeze({ schema_version: 'candidate_match_eval_v1', mode: 'SHADOW',
    case_count: results.length, recall_at_20: mean('recall_at_20'), ndcg_at_10: mean('ndcg_at_10'),
    hard_condition_false_positive_rate: mean('hard_condition_false_positive_rate'),
    evidence_coverage: mean('evidence_coverage'), cases: results });
}

export function runShadowEvaluation(cases) {
  const frozenProduction = cases.map(item => [...item.production_order]);
  const report = evaluateRankingSet(cases);
  if (cases.some((item, index) => JSON.stringify(item.production_order) !== JSON.stringify(frozenProduction[index]))) {
    throw new Error('PRODUCTION_ORDER_MUTATED');
  }
  return report;
}
