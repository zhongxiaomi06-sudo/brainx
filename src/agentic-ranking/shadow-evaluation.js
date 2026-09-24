/** Algorithm A 阶段 08：冻结门槛、同池影子对照与不可投递证据。 */
import { now, uuid } from '../db.js';
import { runAgenticRanking, replayAgenticRanking } from '../agentic-ranking.js';
import { createRecommendationUseCase } from '../recommendation-use-case.js';
import { createRecommendationRepository } from '../recommendation-repository.js';
import { deriveRelation } from '../relations.js';
import { scoreJob, sortRecs } from '../scorer.js';
import { ndcgAtK, RANKING_METRIC_VERSION } from '../ranking-metrics.js';

export const SHADOW_EVALUATION_VERSION = 'agentic-shadow-eval-v1';

const SCENARIOS = new Set([
  'REPEAT', 'CANDIDATE_ORDER_PERTURBED', 'LONG_TEXT', 'MISSING_PROFILE',
  'COLD_START', 'SOURCE_CONFLICT', 'MALICIOUS_CONTENT',
]);
const THRESHOLD_KEYS = [
  'min_runs', 'min_labeled_candidates', 'min_label_coverage', 'min_ndcg_delta',
  'max_avg_cost_micros', 'max_p95_latency_ms', 'max_order_instability',
  'max_segment_ndcg_gap',
];
const SIDE_EFFECT_TABLES = [
  'decision_runs', 'recommendations', 'recommendation_impressions',
  'recommendation_exposure_events', 'push_log',
];

function json(value) {
  return JSON.stringify(value);
}

function parse(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function assertThresholds(value) {
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && THRESHOLD_KEYS.every((key) => Number.isFinite(value[key]));
  const bounded = valid
    && Number.isInteger(value.min_runs) && value.min_runs >= 1
    && Number.isInteger(value.min_labeled_candidates) && value.min_labeled_candidates >= 1
    && value.min_label_coverage >= 0 && value.min_label_coverage <= 1
    && value.min_ndcg_delta >= -1 && value.min_ndcg_delta <= 1
    && value.max_avg_cost_micros >= 0 && value.max_p95_latency_ms >= 0
    && value.max_order_instability >= 0 && value.max_order_instability <= 1
    && value.max_segment_ndcg_gap >= 0 && value.max_segment_ndcg_gap <= 1;
  if (!bounded) throw new TypeError('SHADOW_THRESHOLDS_INVALID');
  return Object.fromEntries(THRESHOLD_KEYS.map((key) => [key, value[key]]));
}

function segmentsOf(value) {
  const segments = Array.isArray(value)
    ? [...new Set(value.map((item) => String(item).trim()).filter(Boolean))] : [];
  if (!segments.length || segments.some((item) => item.length > 80)) {
    throw new TypeError('SHADOW_SEGMENTS_INVALID');
  }
  return segments;
}

function publicPlan(row) {
  return {
    plan_id: row.plan_id, tenant_id: row.tenant_id, name: row.name,
    metric_version: row.metric_version,
    label_definition_version: row.label_definition_version,
    thresholds: parse(row.thresholds_json, {}), segments: parse(row.segments_json, []),
    status: row.status, created_by: row.created_by, created_at: row.created_at,
  };
}

export function registerShadowEvaluationPlan(db, input) {
  if (!input?.planId || !input?.tenantId || !input?.name
    || !input?.labelDefinitionVersion || !input?.createdBy) {
    throw new TypeError('SHADOW_PLAN_INVALID');
  }
  if (db.prepare('SELECT 1 FROM shadow_evaluation_plans WHERE plan_id=?').get(input.planId)) {
    throw new Error('SHADOW_PLAN_ALREADY_EXISTS');
  }
  const thresholds = assertThresholds(input.thresholds);
  const segments = segmentsOf(input.segments);
  db.prepare(`INSERT INTO shadow_evaluation_plans
    (plan_id,tenant_id,name,metric_version,label_definition_version,thresholds_json,
     segments_json,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,'FROZEN',?,?)`)
    .run(input.planId, input.tenantId, input.name, RANKING_METRIC_VERSION,
      input.labelDefinitionVersion, json(thresholds), json(segments), input.createdBy,
      input.at || now());
  return publicPlan(db.prepare('SELECT * FROM shadow_evaluation_plans WHERE plan_id=?')
    .get(input.planId));
}

function counts(db) {
  return Object.fromEntries(SIDE_EFFECT_TABLES.map((table) => [
    table, db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
  ]));
}

function deltas(before, after) {
  return Object.fromEntries(SIDE_EFFECT_TABLES.map((table) => [table, after[table] - before[table]]));
}

function normalizeJudgments(value) {
  const map = new Map();
  for (const row of Array.isArray(value) ? value : []) {
    if (!row?.job_id || !Number.isFinite(row.label) || row.label < 0) {
      throw new TypeError('SHADOW_JUDGMENT_INVALID');
    }
    if (map.has(row.job_id)) throw new TypeError('SHADOW_JUDGMENT_DUPLICATE');
    map.set(String(row.job_id), Number(row.label));
  }
  return map;
}

function fullRanking(order, candidateIds) {
  const allowed = new Set(candidateIds);
  const seen = new Set();
  const ranked = [];
  for (const id of order) {
    if (allowed.has(id) && !seen.has(id)) { ranked.push(id); seen.add(id); }
  }
  for (const id of candidateIds) if (!seen.has(id)) ranked.push(id);
  return ranked;
}

function ndcgFor(order, candidateIds, judgments) {
  return ndcgAtK(fullRanking(order, candidateIds)
    .map((jobId) => ({ job_id: jobId, label: judgments.get(jobId) ?? null })), 10);
}

function topOverlap(left, right, k = 10) {
  const a = new Set(left.slice(0, k));
  const b = new Set(right.slice(0, k));
  const union = new Set([...a, ...b]);
  if (!union.size) return null;
  return [...a].filter((id) => b.has(id)).length / union.size;
}

function orderInstability(current, reference, k = 10) {
  const ids = [...new Set([...current.slice(0, k), ...reference.slice(0, k)])];
  if (!ids.length) return null;
  const position = (order, id) => {
    const index = order.slice(0, k).indexOf(id);
    return index < 0 ? k : index;
  };
  return ids.reduce((sum, id) => sum
    + Math.abs(position(current, id) - position(reference, id)) / k, 0) / ids.length;
}

function usageFor(db, runId) {
  const rows = db.prepare(`SELECT estimated_cost_micros,latency_ms,total_tokens,usage_status
    FROM agent_usage_calls WHERE run_id=? ORDER BY round,attempt`).all(runId);
  const allCostsKnown = rows.length > 0 && rows.every((row) => row.estimated_cost_micros != null);
  const allLatencyKnown = rows.length > 0 && rows.every((row) => row.latency_ms != null);
  const allTokensKnown = rows.length > 0 && rows.every((row) => row.total_tokens != null);
  return {
    calls: rows.length,
    estimated_cost_micros: allCostsKnown
      ? rows.reduce((sum, row) => sum + row.estimated_cost_micros, 0) : null,
    latency_ms: allLatencyKnown ? rows.reduce((sum, row) => sum + row.latency_ms, 0) : null,
    total_tokens: allTokensKnown ? rows.reduce((sum, row) => sum + row.total_tokens, 0) : null,
    usage_complete: rows.length > 0 && rows.every((row) => row.usage_status === 'KNOWN'),
  };
}

function metricsFor(input, baselineOrder, agentOrder, judgments, usage, hardViolations) {
  const candidateIds = input.candidates.map((item) => item.job_id);
  const candidates = new Set(candidateIds);
  const selected = new Set(agentOrder);
  const relevantUniverse = [...judgments].filter(([, label]) => label >= 2).map(([id]) => id);
  const retrievedRelevant = relevantUniverse.filter((id) => candidates.has(id));
  const baselineNdcg = ndcgFor(baselineOrder, candidateIds, judgments);
  const agentNdcg = ndcgFor(agentOrder, candidateIds, judgments);
  const labeledCandidates = candidateIds.filter((id) => judgments.has(id)).length;
  return {
    metric_version: RANKING_METRIC_VERSION,
    candidate_count: candidateIds.length,
    labeled_candidates: labeledCandidates,
    label_coverage: candidateIds.length ? labeledCandidates / candidateIds.length : null,
    retrieval_recall: relevantUniverse.length
      ? retrievedRelevant.length / relevantUniverse.length : null,
    selection_recall: retrievedRelevant.length
      ? retrievedRelevant.filter((id) => selected.has(id)).length / retrievedRelevant.length : null,
    recall_scope: 'PROVIDED_JUDGED_UNIVERSE',
    baseline_ndcg_at_10: baselineNdcg,
    agent_ndcg_at_10: agentNdcg,
    ndcg_delta: baselineNdcg != null && agentNdcg != null ? agentNdcg - baselineNdcg : null,
    top_10_overlap: topOverlap(baselineOrder, agentOrder),
    hard_violation_count: hardViolations,
    ...usage,
  };
}

function reorderedInput(input, mode) {
  if (mode !== 'REVERSE') return input;
  return { ...input, candidates: [...input.candidates].reverse() };
}

function loadReference(db, options, candidateSetRef) {
  if (!options.referenceShadowRunId) return null;
  const row = db.prepare(`SELECT * FROM shadow_evaluation_runs
    WHERE shadow_run_id=? AND plan_id=? AND tenant_id=? AND consultant_id=?
      AND status='SHADOW_COMPLETED'`).get(options.referenceShadowRunId,
    options.planId, options.tenantId, options.consultantId);
  if (!row || row.candidate_set_ref !== candidateSetRef) {
    throw new Error('SHADOW_REFERENCE_INCOMPATIBLE');
  }
  return row;
}

function baselineOnFrozenPool(db, input) {
  const repository = createRecommendationRepository(db);
  const useCase = createRecommendationUseCase(db, {
    repository, nowFn: () => input.as_of,
  });
  const { jobs, relations } = repository.candidates(input.consultant_id);
  const jobMap = new Map(jobs.map((job) => [job.project_id, job]));
  const context = useCase.buildContext(input.consultant_id, { sync_id: input.source_snapshot_id });
  const missing = [];
  const ranked = [];
  for (const candidate of input.candidates) {
    const job = jobMap.get(candidate.job_id);
    if (!job) { missing.push(candidate.job_id); continue; }
    const scored = scoreJob(job, deriveRelation(relations, candidate.job_id), context);
    ranked.push({ job, score: scored.score, evidence_coverage: scored.coverage });
  }
  ranked.sort(sortRecs);
  return { order: ranked.map((item) => item.job.project_id), missing };
}

export async function runShadowEvaluation(db, request, options = {}) {
  const plan = db.prepare(`SELECT * FROM shadow_evaluation_plans
    WHERE plan_id=? AND tenant_id=? AND status='FROZEN'`)
    .get(options.planId, request?.tenantId);
  if (!plan) throw new Error('SHADOW_PLAN_NOT_FOUND');
  if (!SCENARIOS.has(options.scenario)) throw new TypeError('SHADOW_SCENARIO_INVALID');
  const segments = parse(plan.segments_json, []);
  if (!segments.includes(options.segment)) throw new TypeError('SHADOW_SEGMENT_NOT_REGISTERED');
  if (typeof options.agentFn !== 'function') throw new TypeError('SHADOW_AGENT_REQUIRED');
  const judgments = normalizeJudgments(options.judgments);
  const shadowRunId = `ser_${(options.idFn || uuid)()}`;
  const createdAt = (options.nowFn || now)();
  db.prepare(`INSERT INTO shadow_evaluation_runs
    (shadow_run_id,plan_id,tenant_id,consultant_id,scenario,segment,status,
     authorization_version,created_at) VALUES (?,?,?,?,?,?,'RUNNING',?,?)`)
    .run(shadowRunId, options.planId, request.tenantId, request.consultantId,
      options.scenario, options.segment, request.authorizationVersion, createdAt);
  const before = counts(db);
  let frozenBaseline = null;
  const wrappedAgent = (args) => {
    frozenBaseline ||= baselineOnFrozenPool(db, args.input);
    return options.agentFn({
      ...args, input: reorderedInput(args.input, options.candidateOrder),
    });
  };
  try {
    const agentResult = await runAgenticRanking(db, request, {
      ...options, enabled: true, runMode: 'SHADOW', agentFn: wrappedAgent,
    });
    if (!agentResult.run_id) throw new Error(agentResult.failure_code || 'SHADOW_AGENT_RUN_FAILED');
    const replay = replayAgenticRanking(db, {
      tenantId: request.tenantId, consultantId: request.consultantId,
      runId: agentResult.run_id,
    });
    const input = replay.input;
    const baseline = frozenBaseline || baselineOnFrozenPool(db, input);
    const baselineOrder = baseline.order;
    const missingBaseline = baseline.missing;
    const agentOrder = agentResult.items.map((item) => item.job_id);
    const reference = loadReference(db, {
      ...options, tenantId: request.tenantId, consultantId: request.consultantId,
    }, input.candidate_set_ref);
    const referenceOrder = reference ? parse(reference.agentic_json, {}).items || [] : null;
    const stability = {
      reference_shadow_run_id: reference?.shadow_run_id || null,
      order_instability: referenceOrder ? orderInstability(agentOrder, referenceOrder) : null,
      same_candidate_set: reference ? reference.candidate_set_ref === input.candidate_set_ref : null,
    };
    const sideEffectDeltas = deltas(before, counts(db));
    const sideEffectViolations = Object.values(sideEffectDeltas).filter((value) => value !== 0).length;
    const runViolations = ['PUBLISHED', 'ABSTAINED'].includes(agentResult.status) ? 0 : 1;
    const hardViolations = missingBaseline.length + sideEffectViolations + runViolations;
    const usage = usageFor(db, agentResult.run_id);
    const metrics = metricsFor(input, baselineOrder, agentOrder, judgments, usage, hardViolations);
    const evidence = {
      evaluation_version: SHADOW_EVALUATION_VERSION,
      metric_version: RANKING_METRIC_VERSION,
      label_definition_version: plan.label_definition_version,
      model_id: replay.run.model_id, prompt_version: replay.run.prompt_version,
      tool_schema_version: replay.run.tool_schema_version,
      eligibility_policy_version: replay.run.eligibility_policy_version,
      diversity_policy_version: replay.run.diversity_policy_version,
      judged_universe: [...judgments].map(([job_id, label]) => ({ job_id, label })),
      baseline_missing_candidate_ids: missingBaseline,
      side_effect_deltas: sideEffectDeltas,
    };
    const status = hardViolations === 0 ? 'SHADOW_COMPLETED' : 'FAILED';
    const finishedAt = (options.nowFn || now)();
    db.prepare(`UPDATE shadow_evaluation_runs SET status=?,agentic_run_id=?,
      reference_shadow_run_id=?,as_of=?,source_snapshot_id=?,candidate_set_ref=?,
      baseline_json=?,agentic_json=?,metrics_json=?,stability_json=?,evidence_json=?,
      hard_violation_count=?,failure_code=?,finished_at=? WHERE shadow_run_id=?`).run(
      status, agentResult.run_id, reference?.shadow_run_id || null, input.as_of,
      input.source_snapshot_id, input.candidate_set_ref,
      json({ engine: 'baseline-1.1', candidate_set_ref: input.candidate_set_ref,
        items: baselineOrder }),
      json({ engine: 'agentic-ranking-v1', status: agentResult.status, items: agentOrder }),
      json(metrics), json(stability), json(evidence), hardViolations,
      status === 'FAILED' ? 'SHADOW_HARD_VIOLATION' : null, finishedAt, shadowRunId,
    );
    return {
      shadow_run_id: shadowRunId, agentic_run_id: agentResult.run_id, status,
      same_context: {
        authorization_version: input.authorization_version, as_of: input.as_of,
        source_snapshot_id: input.source_snapshot_id,
        baseline_candidate_set_ref: input.candidate_set_ref,
        agent_candidate_set_ref: input.candidate_set_ref,
      },
      metrics, stability, delivery: { attempted: false, side_effect_deltas: sideEffectDeltas },
      business_outcomes: { status: 'NOT_AVAILABLE_IN_SHADOW' }, propensity: null,
    };
  } catch (error) {
    db.prepare(`UPDATE shadow_evaluation_runs SET status='FAILED',failure_code=?,finished_at=?
      WHERE shadow_run_id=?`).run(String(error.code || error.message || 'SHADOW_FAILED').slice(0, 120),
      (options.nowFn || now)(), shadowRunId);
    throw error;
  }
}

function average(values) {
  const known = values.filter((value) => value != null && Number.isFinite(value));
  return known.length === values.length && known.length
    ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function percentile95(values) {
  const known = values.filter((value) => value != null && Number.isFinite(value)).sort((a, b) => a - b);
  if (known.length !== values.length || !known.length) return null;
  return known[Math.max(0, Math.ceil(known.length * 0.95) - 1)];
}

export function summarizeShadowEvaluationPlan(db, { tenantId, planId }) {
  const planRow = db.prepare(`SELECT * FROM shadow_evaluation_plans
    WHERE tenant_id=? AND plan_id=? AND status='FROZEN'`).get(tenantId, planId);
  if (!planRow) throw new Error('SHADOW_PLAN_NOT_FOUND');
  const plan = publicPlan(planRow);
  const allRows = db.prepare(`SELECT * FROM shadow_evaluation_runs
    WHERE tenant_id=? AND plan_id=? AND status!='RUNNING' ORDER BY created_at,shadow_run_id`)
    .all(tenantId, planId);
  const rows = allRows.filter((row) => row.status === 'SHADOW_COMPLETED');
  const entries = rows.map((row) => ({ row, metrics: parse(row.metrics_json, {}),
    stability: parse(row.stability_json, {}) }));
  const ndcgDelta = average(entries.map((entry) => entry.metrics.ndcg_delta));
  const labelCoverage = average(entries.map((entry) => entry.metrics.label_coverage));
  const avgCost = average(entries.map((entry) => entry.metrics.estimated_cost_micros));
  const p95Latency = percentile95(entries.map((entry) => entry.metrics.latency_ms));
  const stabilityValues = entries.map((entry) => entry.stability.order_instability)
    .filter((value) => value != null);
  const orderInstabilityAvg = stabilityValues.length ? average(stabilityValues) : null;
  const segmentMeans = Object.fromEntries(plan.segments.map((segment) => {
    const values = entries.filter((entry) => entry.row.segment === segment)
      .map((entry) => entry.metrics.agent_ndcg_at_10);
    return [segment, values.length ? average(values) : null];
  }));
  const knownSegments = Object.values(segmentMeans).filter((value) => value != null);
  const segmentGap = knownSegments.length === plan.segments.length
    ? Math.max(...knownSegments) - Math.min(...knownSegments) : null;
  const labeledCandidates = entries.reduce((sum, entry) =>
    sum + Number(entry.metrics.labeled_candidates || 0), 0);
  const hardViolations = allRows.reduce((sum, row) =>
    sum + Number(row.hard_violation_count || (row.status === 'FAILED' ? 1 : 0)), 0);
  const enoughEvidence = rows.length >= plan.thresholds.min_runs
    && labeledCandidates >= plan.thresholds.min_labeled_candidates
    && labelCoverage != null && labelCoverage >= plan.thresholds.min_label_coverage
    && avgCost != null && p95Latency != null && orderInstabilityAvg != null
    && segmentGap != null;
  const checks = {
    hard_violations: hardViolations === 0,
    ndcg_noninferiority: ndcgDelta != null && ndcgDelta >= plan.thresholds.min_ndcg_delta,
    cost: avgCost != null && avgCost <= plan.thresholds.max_avg_cost_micros,
    latency: p95Latency != null && p95Latency <= plan.thresholds.max_p95_latency_ms,
    stability: orderInstabilityAvg != null
      && orderInstabilityAvg <= plan.thresholds.max_order_instability,
    segment_gap: segmentGap != null && segmentGap <= plan.thresholds.max_segment_ndcg_gap,
  };
  const thresholdsMet = Object.values(checks).every(Boolean);
  return {
    plan, runs: rows.length, attempted_runs: allRows.length,
    failed_runs: allRows.length - rows.length, labeled_candidates: labeledCandidates,
    metrics: {
      label_coverage: labelCoverage, ndcg_delta: ndcgDelta,
      avg_cost_micros: avgCost, p95_latency_ms: p95Latency,
      order_instability: orderInstabilityAvg, segment_ndcg: segmentMeans,
      segment_ndcg_gap: segmentGap, hard_violation_count: hardViolations,
    },
    checks,
    recommendation: !enoughEvidence ? 'INSUFFICIENT_EVIDENCE'
      : thresholdsMet ? 'READY_FOR_CONTROLLED_GRAY' : 'THRESHOLDS_NOT_MET',
    all_users_allowed: false,
    business_outcomes: { status: 'NOT_AVAILABLE_IN_SHADOW' },
  };
}
