/** ltr-features.js — LambdaMART 特征层（算法文档 §3.3 六类特征）。
 * 新推荐生成时从当时可见的 recommendation + job_facts 提取并冻结；历史训练和
 * 影子评估只读该快照，不重新读取后来变化的职位事实。
 *
 * 六类（文档口径 → 实现字段）：
 *   需求真实性：active_state(OPEN=1)、hc、事实新鲜度(距 captured_at 天数)
 *   Pipeline 活跃度：chat_msgs_7d、chat_last_at 距今天数、pipeline 阶段数
 *   招聘紧迫度：hc、stage 序（INTERVIEW>SCREENING>其他）、notes 紧急词命中
 *   顾问匹配度：direction/similarity 两维分（scorer breakdown 原值）
 *   交付潜力：outcomes_avg（buildCtx 同口径）、capacity 维分
 *   风险可信度：evidence_coverage、exploration 维分（不作价值信号，仅供模型学习位置）
 */

export const LTR_FEATURE_VERSION = 'ltr-feat-v1';

export const LTR_FEATURES = [
  'state_open', 'hc', 'freshness_days',
  'chat_msgs_7d', 'chat_silent_days', 'pipeline_stages',
  'stage_rank', 'urgent_hit', 'hc_gap',
  'dim_direction', 'dim_similarity',
  'outcomes_avg', 'dim_capacity',
  'evidence_coverage', 'dim_exploration',
];

const STAGE_RANK = { OFFER: 5, INTERVIEW: 4, SCREENING: 3, SOURCING: 2, OPEN: 1 };
const URGENT_RE = /紧急|急招|补位|立即|urgent|asap/i;

/** 由一条待冻结推荐（含 breakdown 与 job）+ ctx 提取特征向量（按 LTR_FEATURES 序）。 */
export function featuresOf(rec, { nowIso }) {
  const job = rec.job || {};
  const bd = rec.breakdown || {};
  const dim = (k) => (typeof bd[k] === 'number' ? bd[k] : (bd[k]?.score ?? null));
  const capturedMs = Date.parse(job.captured_at || 0);
  const freshness = Number.isFinite(capturedMs) && capturedMs > 0
    ? Math.max(0, (Date.parse(nowIso) - capturedMs) / 86400000) : 30;
  const chatMs = Date.parse(String(job.chat_last_at || '').replace(' ', 'T') + ':00+08:00');
  const silent = Number.isFinite(chatMs)
    ? Math.max(0, (Date.parse(nowIso) - chatMs) / 86400000) : 30;
  const stages = String(job.pipeline || '').split(/[·,，、]/).filter((s) => s.trim()).length;
  const hc = Number.isFinite(Number(job.hc)) ? Number(job.hc) : 0;
  return {
    state_open: job.active_state === 'OPEN' ? 1 : 0,
    hc,
    freshness_days: Math.min(90, freshness),
    chat_msgs_7d: Number(job.chat_msgs_7d) || 0,
    chat_silent_days: Math.min(90, silent),
    pipeline_stages: stages,
    stage_rank: STAGE_RANK[job.current_stage] || 0,
    urgent_hit: URGENT_RE.test(String(job.notes || '')) ? 1 : 0,
    hc_gap: hc,
    dim_direction: dim('direction') ?? 0,
    dim_similarity: dim('similarity') ?? 0,
    outcomes_avg: Number.isFinite(rec.outcomes_avg) ? rec.outcomes_avg : 0,
    dim_capacity: dim('capacity') ?? 0,
    evidence_coverage: rec.evidence_coverage ?? 0,
    dim_exploration: dim('exploration') ?? 0,
  };
}

/** 新推荐写入时冻结；与 recommendation 行在同一事务持久化。 */
export function createFeatureSnapshot(rec, { nowIso }) {
  if (!Number.isFinite(Date.parse(nowIso))) throw new TypeError('nowIso 必须是有效时间');
  return {
    schema_version: LTR_FEATURE_VERSION,
    captured_at: nowIso,
    features: featuresOf(rec, { nowIso }),
  };
}

/** 历史读取严格失败关闭，不用当前职位事实填补缺失或损坏的快照。 */
export function readFeatureSnapshot(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'MISSING_FEATURE_SNAPSHOT' };
  }
  let snapshot;
  try {
    snapshot = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'INVALID_FEATURE_SNAPSHOT' };
  }
  if (snapshot?.schema_version !== LTR_FEATURE_VERSION) {
    return { ok: false, reason: 'FEATURE_SNAPSHOT_VERSION_MISMATCH' };
  }
  if (!Number.isFinite(Date.parse(snapshot.captured_at)) || !snapshot.features) {
    return { ok: false, reason: 'INVALID_FEATURE_SNAPSHOT' };
  }
  const features = {};
  for (const name of LTR_FEATURES) {
    const value = snapshot.features[name];
    if (!Number.isFinite(value)) return { ok: false, reason: 'INVALID_FEATURE_SNAPSHOT' };
    features[name] = value;
  }
  return { ok: true, schema_version: snapshot.schema_version,
    captured_at: snapshot.captured_at, features };
}

export function featureVector(rec, ctx) {
  const f = featuresOf(rec, ctx);
  return LTR_FEATURES.map((k) => f[k]);
}
