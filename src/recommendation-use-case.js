/** baseline-1.1 推荐用例：只编排领域规则，通过 repository port 读写。 */
import { now, uuid } from './db.js';
import { POLICY_VERSION, hardBlock, scoreJob, actionOf,
  sortRecs, explain, normalizeWeights } from './scorer.js';
import { deriveRelation } from './relations.js';
import { dataConfidenceOf, presentationEvidence,
  recommendationPresentationOf } from './recommendation-presentation.js';
import { createFeatureSnapshot } from './ltr-features.js';
import { createRecommendationRepository } from './recommendation-repository.js';
import { recommendationConfigFromEnv } from './recommendation-config.js';

const REPOSITORY_METHODS = [
  'consultants', 'syncState', 'contextData', 'candidates', 'latestCompletedRun',
  'latestThrottleAudit', 'insertThrottleAudit', 'persistRun', 'readRun',
  'hiddenProjectIds', 'engagementState',
];

function assertRepository(repository) {
  for (const method of REPOSITORY_METHODS) {
    if (typeof repository?.[method] !== 'function') {
      throw new TypeError(`RECOMMENDATION_REPOSITORY_INVALID:${method}`);
    }
  }
}

export const publicRecommendation = (item) => ({
  decision_id: item.decision_id,
  rank: item.rank,
  action: item.action,
  score: item.score,
  confidence_band: item.confidence_band,
  evidence_coverage: item.evidence_coverage,
  reasons: item.reasons,
  risks: item.risks,
  evidence_refs: item.evidence_refs,
  breakdown: item.breakdown,
  job: {
    project_id: item.job.project_id,
    company: item.job.company,
    role: item.job.role,
    city: item.job.city,
    pipeline: item.job.pipeline,
    hc: item.job.hc,
    active_state: item.job.active_state,
    priority: item.job.priority ?? null,
    notes: item.job.notes ?? null,
    company_type: item.job.company_type ?? null,
    current_stage: item.job.current_stage ?? null,
    pipeline_snapshot: item.job.pipeline_snapshot ?? null,
    next_action: item.job.next_action ?? null,
    fact_sources: item.job.fact_sources ?? {},
    fact_updated_at: item.job.fact_updated_at ?? {},
    relation: item.relation,
    source_url: item.job.source_url,
    captured_at: item.job.captured_at,
  },
});

function contextOf(repository, consultantId, snapshot, at) {
  const data = repository.contextData(consultantId);
  return {
    consultant_id: consultantId,
    profile_keywords: data.consultant.profile_keywords || [],
    capacity_limit: Number(data.consultant.capacity_limit) > 0
      ? Number(data.consultant.capacity_limit) : undefined,
    weights: normalizeWeights(data.consultant.weights ?? null).weights ?? undefined,
    historical_texts: data.historicalTexts,
    watched_count: 0,
    accepted_count: data.acceptedCount,
    outcomes_avg: data.outcomesAvg,
    feedback_projects: data.feedbackProjects,
    negative_companies: data.negativeCompanies,
    positive_companies: data.positiveCompanies,
    rec_rounds: data.recommendationRounds,
    engaged_projects: data.engagedProjects,
    now: at,
    snapshot_id: snapshot?.sync_id || '',
  };
}

function withoutEngaged(repository, consultantId, items) {
  const hidden = repository.hiddenProjectIds(consultantId);
  return items.filter((item) => {
    const projectId = item.job?.project_id;
    if (!projectId || hidden.has(projectId)) return false;
    if (repository.engagementState(consultantId, projectId) === 'ACCEPTED') return false;
    return !['CLOSED', 'COMPLETED', 'COOLING'].includes(item.job?.active_state);
  });
}

function materialize(repository, consultantId, stored, hideEngaged) {
  if (!stored) return null;
  const jobMap = Object.fromEntries(stored.jobs.map((job) => [job.project_id, job]));
  const items = stored.rows.map((row) => ({
    decision_id: row.decision_id,
    rank: row.rank,
    action: row.action,
    score: row.score,
    confidence_band: row.confidence_band,
    evidence_coverage: row.evidence_coverage,
    reasons: JSON.parse(row.reasons_json),
    risks: JSON.parse(row.risks_json),
    evidence_refs: JSON.parse(row.evidence_refs_json),
    breakdown: JSON.parse(row.breakdown_json),
    job: {
      ...jobMap[row.project_id],
      raw_json: undefined,
      relation: deriveRelation(stored.relations, row.project_id),
    },
  }));
  return { run: stored.run,
    items: hideEngaged ? withoutEngaged(repository, consultantId, items) : items };
}

export function createRecommendationUseCase(db, {
  repository = createRecommendationRepository(db),
  config = recommendationConfigFromEnv(),
  nowFn = now,
  idFn = uuid,
} = {}) {
  assertRepository(repository);
  const buildContext = (consultantId, snapshot) => contextOf(
    repository, consultantId, snapshot, nowFn(),
  );

  const run = (consultantId, {
    top = 20,
    dry_run = false,
    throttle = false,
    persistLimit = config.persistLimit,
  } = {}) => {
    const { last, snapshot, syncWarning } = repository.syncState(consultantId);
    if (!snapshot) {
      return { blocked: true, reason: '无完整快照，先同步', items: [], run_id: null };
    }
    if (!last || !last.complete) {
      return {
        blocked: true,
        reason: '本次同步不完整，暂不生成正式推荐',
        sync: last,
        snapshot_id: snapshot.sync_id,
        items: [],
        run_id: null,
      };
    }

    if (throttle && !dry_run) {
      const previous = repository.latestCompletedRun(consultantId);
      const at = nowFn();
      if (previous && Date.parse(at) - Date.parse(previous.created_at) < config.throttleMs) {
        const audit = repository.latestThrottleAudit(consultantId);
        if (!audit || Date.parse(at) - Date.parse(audit.created_at) >= config.skipAuditMs) {
          repository.insertThrottleAudit({
            runId: idFn(), consultantId, snapshotId: snapshot.sync_id,
            policyVersion: POLICY_VERSION, createdAt: at,
          });
        }
        return {
          skipped: true,
          reason: '自动推荐距上轮不足 2h，复用上轮',
          blocked: false,
          run_id: previous.run_id,
          items: null,
          sync_warning: syncWarning,
          generated_at: nowFn(),
        };
      }
    }

    const { jobs, relations, ignored } = repository.candidates(consultantId);
    const context = buildContext(consultantId, snapshot);
    const evaluated = [];
    let blockedCount = 0;
    for (const job of jobs) {
      if (ignored.has(job.project_id)) {
        blockedCount += 1;
        continue;
      }
      const relation = deriveRelation(relations, job.project_id);
      if (hardBlock(job, relation, true)) {
        blockedCount += 1;
        continue;
      }
      const scored = scoreJob(job, relation, context);
      const confidence = dataConfidenceOf(job, relation, context.now);
      const action = confidence.band === 'INSUFFICIENT'
        ? 'OBSERVE' : actionOf(scored.score, scored.coverage);
      const presentation = recommendationPresentationOf(
        job, relation, action, context.now, confidence,
      );
      const { reasons, risks, evidence_refs: evidenceRefs } = explain(
        job, relation, scored, context,
      );
      const item = {
        decision_id: idFn(), project_id: job.project_id, job, relation, action,
        score: scored.score, evidence_coverage: scored.coverage,
        confidence_band: {
          SUFFICIENT: 'HIGH', PARTIAL: 'MEDIUM', INSUFFICIENT: 'LOW',
        }[confidence.band],
        reasons, risks,
        evidence_refs: [...evidenceRefs, presentationEvidence(presentation)],
        breakdown: scored.breakdown,
        outcomes_avg: context.outcomes_avg,
      };
      item.feature_snapshot_json = JSON.stringify(
        createFeatureSnapshot(item, { nowIso: context.now }),
      );
      evaluated.push(item);
    }
    evaluated.sort(sortRecs);
    evaluated.forEach((item, index) => { item.rank = index + 1; });

    const runId = idFn();
    if (!dry_run) {
      repository.persistRun({
        runId, consultantId, snapshotId: snapshot.sync_id,
        policyVersion: POLICY_VERSION, evaluated, top,
        persistLimit: Math.max(top, Number(persistLimit) || config.persistLimit),
        createdAt: nowFn(),
      });
    }
    return {
      run_id: runId,
      blocked: false,
      snapshot_id: snapshot.sync_id,
      policy_version: POLICY_VERSION,
      input_stats: {
        candidates: jobs.length,
        after_hard_filter: evaluated.length,
        blocked: blockedCount,
      },
      items: evaluated.slice(0, top).map(publicRecommendation),
      sync_warning: syncWarning,
      generated_at: nowFn(),
    };
  };

  const readRun = (consultantId, runId = null, { hideEngaged = false } = {}) => materialize(
    repository, consultantId, repository.readRun(consultantId, runId), hideEngaged,
  );

  return Object.freeze({
    run,
    readRun,
    latest: (consultantId, options = {}) => readRun(consultantId, null, options),
    consultants: () => repository.consultants(),
    buildContext,
    hideEngaged: (consultantId, items) => withoutEngaged(repository, consultantId, items),
    policyVersion: POLICY_VERSION,
  });
}
