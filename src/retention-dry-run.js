/** 显式策略的只读数据保留规划；只输出聚合计数，不生成删除集合。 */

const POLICY_VERSION = 'retention-policy-v1';
const PLAN_VERSION = 'retention-plan-v1';
const DAY_MS = 24 * 60 * 60 * 1000;

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((row) => row.name));
}

function supports(db, requirements) {
  return Object.entries(requirements).every(([table, required]) => {
    const available = columns(db, table);
    return required.every((column) => available.has(column));
  });
}

function integer(value, name, { min = 1, max = 3650 } = {}) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`INVALID_RETENTION_POLICY:${name}`);
  }
  return value;
}

function validatePolicy(policy) {
  if (!policy || policy.contract_version !== POLICY_VERSION) {
    throw new TypeError('INVALID_RETENTION_POLICY:contract_version');
  }
  const asOfMs = Date.parse(policy.as_of);
  if (!Number.isFinite(asOfMs) || new Date(asOfMs).toISOString() !== policy.as_of) {
    throw new TypeError('INVALID_RETENTION_POLICY:as_of');
  }
  const recommendation = policy.categories?.recommendation_snapshots;
  const throttled = policy.categories?.throttled_runs;
  if (!recommendation || !throttled) {
    throw new TypeError('INVALID_RETENTION_POLICY:categories');
  }
  return {
    asOf: policy.as_of,
    asOfMs,
    recommendationTtl: integer(recommendation.ttl_days, 'recommendation_snapshots.ttl_days'),
    keepRuns: integer(recommendation.keep_latest_runs_per_consultant,
      'recommendation_snapshots.keep_latest_runs_per_consultant', { max: 100 }),
    throttledTtl: integer(throttled.ttl_days, 'throttled_runs.ttl_days'),
  };
}

const RECOMMENDATION_REQUIREMENTS = Object.freeze({
  decision_runs: ['run_id', 'consultant_id', 'status', 'created_at'],
  recommendations: ['decision_id', 'run_id', 'created_at', 'feature_snapshot_json'],
  recommendation_impressions: ['decision_id', 'served_at'],
  job_outcomes: ['decision_id'],
  decision_events: ['decision_id'],
  recommendation_feedback_events: ['decision_id'],
});

function blockedRecommendationCategory() {
  return {
    status: 'BLOCKED_SCHEMA_CAPABILITY', total: null, eligible_by_age: null,
    protected: null, candidate_count: null,
  };
}

function recommendationPlan(db, { recommendationTtl, keepRuns, asOfMs }) {
  if (!supports(db, RECOMMENDATION_REQUIREMENTS)) return blockedRecommendationCategory();
  const cutoff = new Date(asOfMs - recommendationTtl * DAY_MS).toISOString();
  const ranked = `WITH ranked AS (
    SELECT run_id,
      ROW_NUMBER() OVER (
        PARTITION BY consultant_id ORDER BY julianday(created_at) DESC, run_id DESC
      ) recent_rank
    FROM decision_runs WHERE status='COMPLETED'
  )`;
  const age = 'julianday(r.created_at) < julianday(?)';
  const stale = `${age} AND rr.recent_rank > ?`;
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n || 0);
  const referenceCount = (table, alias, extra = '') => count(`${ranked}
    SELECT COUNT(DISTINCT r.decision_id) n
    FROM recommendations r JOIN ranked rr ON rr.run_id=r.run_id
    WHERE ${stale} AND EXISTS (
      SELECT 1 FROM ${table} ${alias} WHERE ${alias}.decision_id=r.decision_id${extra}
    )`, cutoff, keepRuns);
  const total = count('SELECT COUNT(*) n FROM recommendations');
  const eligible = count(`${ranked} SELECT COUNT(*) n FROM recommendations r
    JOIN ranked rr ON rr.run_id=r.run_id WHERE ${age}`, cutoff);
  const recent = count(`${ranked} SELECT COUNT(*) n FROM recommendations r
    JOIN ranked rr ON rr.run_id=r.run_id
    WHERE ${age} AND rr.recent_rank <= ?`, cutoff, keepRuns);
  const candidate = count(`${ranked} SELECT COUNT(*) n FROM recommendations r
    JOIN ranked rr ON rr.run_id=r.run_id WHERE ${stale}
      AND NOT EXISTS (SELECT 1 FROM recommendation_impressions i WHERE i.decision_id=r.decision_id)
      AND NOT EXISTS (SELECT 1 FROM job_outcomes o WHERE o.decision_id=r.decision_id)
      AND NOT EXISTS (SELECT 1 FROM decision_events e WHERE e.decision_id=r.decision_id)
      AND NOT EXISTS (
        SELECT 1 FROM recommendation_feedback_events f WHERE f.decision_id=r.decision_id
      )`, cutoff, keepRuns);
  return {
    status: 'READY', total, eligible_by_age: eligible,
    protected: {
      recent_runs: recent,
      impressions: referenceCount('recommendation_impressions', 'i'),
      served_impressions: referenceCount(
        'recommendation_impressions', 'i', ' AND i.served_at IS NOT NULL'),
      business_outcomes: referenceCount('job_outcomes', 'o'),
      decision_events: referenceCount('decision_events', 'e'),
      feedback_events: referenceCount('recommendation_feedback_events', 'f'),
    },
    candidate_count: candidate,
  };
}

function throttledPlan(db, { throttledTtl, asOfMs }) {
  const requirements = {
    decision_runs: ['run_id', 'status', 'created_at'], recommendations: ['run_id'],
  };
  if (!supports(db, requirements)) {
    return { status: 'BLOCKED_SCHEMA_CAPABILITY', total: null, eligible_by_age: null,
      protected: null, candidate_count: null };
  }
  const cutoff = new Date(asOfMs - throttledTtl * DAY_MS).toISOString();
  const status = "d.status IN ('SKIPPED_THROTTLED','SKIPPED_UNCHANGED')";
  const age = 'julianday(d.created_at) < julianday(?)';
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params).n || 0);
  const total = count(`SELECT COUNT(*) n FROM decision_runs d WHERE ${status}`);
  const eligible = count(`SELECT COUNT(*) n FROM decision_runs d
    WHERE ${status} AND ${age}`, cutoff);
  const hasRecommendations = count(`SELECT COUNT(*) n FROM decision_runs d
    WHERE ${status} AND ${age}
      AND EXISTS (SELECT 1 FROM recommendations r WHERE r.run_id=d.run_id)`, cutoff);
  const candidate = count(`SELECT COUNT(*) n FROM decision_runs d
    WHERE ${status} AND ${age}
      AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.run_id=d.run_id)`, cutoff);
  return { status: 'READY', total, eligible_by_age: eligible,
    protected: { has_recommendations: hasRecommendations }, candidate_count: candidate };
}

const blockedPolicyCategory = () => ({
  status: 'BLOCKED_POLICY_NOT_IMPLEMENTED', candidate_count: null,
});

export function buildRetentionPlan(db, policy) {
  const validated = validatePolicy(policy);
  return {
    contract_version: PLAN_VERSION,
    policy_contract_version: POLICY_VERSION,
    as_of: validated.asOf,
    read_only: true,
    identifiers_emitted: false,
    execution_supported: false,
    execution_ready: false,
    categories: {
      recommendation_snapshots: recommendationPlan(db, validated),
      throttled_runs: throttledPlan(db, validated),
      ttc_field_reports: blockedPolicyCategory(),
      sync_runs: blockedPolicyCategory(),
      raw_contexts: blockedPolicyCategory(),
    },
  };
}
