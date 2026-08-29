/** 推荐卡片展示契约：只把真实事实转换为版本化层级、可信度与最近活动。 */
export const RECOMMENDATION_PRESENTATION_VERSION = 'recommendation-presentation-1.0';
export const DATA_CONFIDENCE_RULE_VERSION = 'data-confidence-1.0';

const DAY_MS = 86400000;
const criticalFields = [
  ['active_state', '招聘状态'],
  ['relation', '职位关系'],
  ['hc', 'HC'],
  ['current_stage', '当前阶段'],
];
const manualFieldLabels = {
  active_state: '招聘状态',
  current_stage: '当前阶段',
  pipeline_snapshot: 'Pipeline',
  remaining_hc: 'HC',
  next_action: '下一步动作',
  notes: '备注',
};

function timestamp(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)
    ? `${text.slice(0, 16).replace(' ', 'T')}:00+08:00`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function newest(candidates) {
  return candidates.filter((candidate) => candidate?.occurred_at)
    .sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at))[0] || null;
}

export function recentActivityOf(job) {
  const candidates = [];
  const capturedAt = timestamp(job.captured_at);
  if (capturedAt) candidates.push({
    type: 'JOB_FACT_UPDATED', label: '职位事实更新', occurred_at: capturedAt, source: 'SYNC', detail: null,
  });
  const chatAt = timestamp(job.chat_last_at);
  if (chatAt) candidates.push({
    type: 'CHAT_ACTIVITY', label: '业务群活动', occurred_at: chatAt, source: 'FEISHU_CHAT',
    detail: Number.isInteger(job.chat_msgs_7d) ? `近7天 ${job.chat_msgs_7d} 条消息` : null,
  });
  for (const [field, value] of Object.entries(job.fact_updated_at || {})) {
    const occurredAt = timestamp(value);
    if (!occurredAt) continue;
    candidates.push({
      type: 'MANUAL_FACT_UPDATED', label: `人工核验${manualFieldLabels[field] || field}`,
      occurred_at: occurredAt, source: 'MANUAL', detail: null,
    });
  }
  return newest(candidates);
}

export function dataConfidenceOf(job, relation, evaluatedAt) {
  const values = { ...job, relation };
  const missingFields = criticalFields.filter(([field]) => {
    const value = values[field];
    return value === null || value === undefined || value === ''
      || value === 'UNKNOWN' || (field === 'relation' && value === 'NOT_JOINED');
  }).map(([, label]) => label);
  const latestFactAt = newest([
    { occurred_at: timestamp(job.captured_at) },
    ...Object.values(job.fact_updated_at || {}).map((value) => ({ occurred_at: timestamp(value) })),
  ])?.occurred_at || null;
  const evaluated = timestamp(evaluatedAt);
  const ageDays = latestFactAt && evaluated
    ? Math.max(0, (Date.parse(evaluated) - Date.parse(latestFactAt)) / DAY_MS)
    : null;
  const stale = ageDays === null || ageDays > 30;
  const aging = ageDays !== null && ageDays > 7;
  let band = 'SUFFICIENT';
  if (stale || missingFields.length >= 2) band = 'INSUFFICIENT';
  else if (aging || missingFields.length === 1) band = 'PARTIAL';

  const reasons = [];
  if (missingFields.length) reasons.push({ code: 'CRITICAL_FACTS_MISSING', text: `${missingFields.join('、')}待确认` });
  if (stale) reasons.push({ code: 'FACTS_STALE', text: latestFactAt ? '职位事实已超过30天有效窗口' : '缺少可用的事实更新时间' });
  else if (aging) reasons.push({ code: 'FACTS_AGING', text: '职位事实已超过7天，接近有效窗口' });
  if (!reasons.length) reasons.push({ code: 'FACTS_CURRENT', text: '关键事实齐全且在7天有效窗口内' });

  const primaryRisk = stale
    ? '职位事实已超过有效窗口，请先核验招聘状态、HC 和阶段。'
    : missingFields.length
      ? `${missingFields.join('、')}待确认，推进前请先核验。`
      : aging ? '职位事实接近有效窗口，请在推进前确认仍然有效。' : null;
  return {
    band, rule_version: DATA_CONFIDENCE_RULE_VERSION, missing_fields: missingFields,
    latest_fact_at: latestFactAt, age_days: ageDays === null ? null : Math.floor(ageDays),
    stale, reasons, primary_risk: primaryRisk,
  };
}

export function recommendationPresentationOf(job, relation, action, evaluatedAt, confidence = null) {
  const dataConfidence = confidence || dataConfidenceOf(job, relation, evaluatedAt);
  let decisionTier = 'WEEK';
  let decisionTierReason = { code: 'NO_IMMEDIATE_ACTION', text: '当前没有必须今天完成的已验证动作' };
  if (dataConfidence.band === 'INSUFFICIENT' || action === 'OBSERVE') {
    decisionTier = 'VERIFY';
    decisionTierReason = { code: 'FACTS_REQUIRE_VERIFICATION', text: '关键事实不足，先核验再推进' };
  } else if (action === 'RECOMMEND_ACCEPT' && job.next_action && dataConfidence.band === 'SUFFICIENT') {
    decisionTier = 'TODAY';
    decisionTierReason = { code: 'EXPLICIT_NEXT_ACTION', text: `已有明确下一步：${String(job.next_action).slice(0, 120)}` };
  }
  return {
    version: RECOMMENDATION_PRESENTATION_VERSION,
    decision_tier: decisionTier,
    decision_tier_reason: decisionTierReason,
    data_confidence: dataConfidence,
    recent_activity: recentActivityOf(job),
  };
}

export function presentationEvidence(presentation) {
  return {
    type: 'decision_presentation', ref: presentation.version,
    excerpt: `${presentation.decision_tier} · ${presentation.data_confidence.band}`,
    metadata: presentation,
  };
}

export function presentationForRecommendation(item, evaluatedAt) {
  const frozen = item.evidence_refs?.find((ref) => ref?.type === 'decision_presentation')?.metadata;
  if (frozen?.version === RECOMMENDATION_PRESENTATION_VERSION) {
    return { ...frozen, source: 'FROZEN' };
  }
  return {
    ...recommendationPresentationOf(item.job, item.job.relation, item.action, evaluatedAt),
    source: 'DERIVED_LEGACY',
  };
}
