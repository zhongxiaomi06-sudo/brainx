/** Algorithm A 的硬过滤、多路召回与冻结输入。召回元数据不产生最终分数。 */
import { effectiveJobs, effectiveJob } from '../facts.js';
import { sha256 } from '../job-source-contract.js';
import { ignoredProjectIds } from '../opportunity-ignore.js';
import { currentConsultantContext, currentProjectLoad } from '../profile-outcome-ledger.js';
import { latestRealSync } from '../sync.js';
import { jobVisibleTo } from '../visibility.js';

const text = (value) => String(value || '').trim().toLowerCase();
const list = (value) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

function excluded(job, profile) {
  const company = text(job.company);
  const role = text(job.role);
  const cities = [job.city, ...(job.cities || [])].map(text).filter(Boolean);
  return list(profile.excluded_companies).some((value) => company.includes(value))
    || list(profile.excluded_roles).some((value) => role.includes(value))
    || list(profile.excluded_cities).some((value) => cities.some((city) => city.includes(value)));
}

function latestFactVersions(db, tenantId) {
  return new Map(db.prepare(`SELECT v.* FROM job_fact_versions v
    WHERE v.tenant_id=? AND v.version=(SELECT MAX(v2.version) FROM job_fact_versions v2
      WHERE v2.tenant_id=v.tenant_id AND v2.job_id=v.job_id)`).all(tenantId)
    .map((row) => [row.job_id, row]));
}

function evidenceRefs(db, version) {
  const refs = db.prepare(`SELECT evidence_id FROM job_field_evidence
    WHERE fact_version=? ORDER BY field_path, evidence_id LIMIT 50`).all(version.fact_version)
    .map((row) => row.evidence_id);
  return refs.length ? refs : [`${version.fact_version}:canonical`];
}

function historyCompanies(db, consultantId) {
  return new Set(db.prepare(`SELECT DISTINCT lower(j.company) company
    FROM decision_events e JOIN job_facts j ON j.project_id=e.project_id
    WHERE e.actor=? AND e.event_type='ACCEPTED'`).all(consultantId)
    .map((row) => row.company));
}

function laneTags(job, profile, historical, supplyIds) {
  const searchable = text(`${job.company} ${job.role} ${job.notes || ''}`);
  const lanes = [];
  if (list(profile.profile_keywords).some((keyword) => searchable.includes(keyword))) {
    lanes.push('EXPLICIT_DIRECTION');
  }
  if (historical.has(text(job.company))) lanes.push('HISTORICAL_SIMILAR');
  lanes.push('RECENT_DEMAND');
  if (supplyIds.has(job.project_id)) lanes.push('SUPPLY_AVAILABLE');
  if (parseInt(sha256(job.project_id).slice(0, 4), 16) % 5 === 0) lanes.push('EXPLORATION');
  return lanes;
}

function latestSnapshot(db, consultantId) {
  const sync = latestRealSync(db, consultantId);
  if (!sync) throw Object.assign(new Error('SOURCE_SNAPSHOT_MISSING'), { code: 'SOURCE_SNAPSHOT_MISSING' });
  if (!sync.complete) {
    throw Object.assign(new Error('SOURCE_SNAPSHOT_INCOMPLETE'), { code: 'SOURCE_SNAPSHOT_INCOMPLETE' });
  }
  return sync;
}

export function buildFrozenRankingInput(db, request, versions) {
  const snapshot = latestSnapshot(db, request.consultantId);
  const context = currentConsultantContext(db, {
    tenantId: request.tenantId, consultantId: request.consultantId, at: versions.at,
  });
  if (!context.profile_version) {
    throw Object.assign(new Error('PROFILE_VERSION_MISSING'), { code: 'PROFILE_VERSION_MISSING' });
  }
  const ignored = ignoredProjectIds(db, request.consultantId);
  const accepted = new Set(db.prepare(`SELECT project_id FROM current_engagement
    WHERE consultant_id=? AND state='ACCEPTED'`).all(request.consultantId)
    .map((row) => row.project_id));
  const capacity = Number(context.profile.capacity_limit);
  const capacityBlocked = Number.isFinite(capacity) && capacity > 0
    && context.load.accepted_projects >= capacity;
  const facts = latestFactVersions(db, request.tenantId);
  const historical = historyCompanies(db, request.consultantId);
  const supplyIds = new Set(versions.supplyJobIds || []);
  const eligible = capacityBlocked ? [] : effectiveJobs(db, request.consultantId)
    .filter((job) => job.active_state === 'OPEN' && job.hc !== 0)
    .filter((job) => jobVisibleTo(db, request.consultantId, job.project_id))
    .filter((job) => !ignored.has(job.project_id) && !accepted.has(job.project_id))
    .filter((job) => !excluded(job, context.profile) && facts.has(job.project_id))
    .sort((a, b) => a.project_id.localeCompare(b.project_id));
  const candidates = eligible.slice(0, 200).map((job) => {
    const version = facts.get(job.project_id);
    return {
      job_id: job.project_id,
      job_fact_version: version.fact_version,
      source_snapshot_id: version.source_snapshot_id,
      retrieval_lanes: laneTags(job, context.profile, historical, supplyIds),
      evidence_refs: evidenceRefs(db, version),
      facts: {
        company: job.company, role: job.role, city: job.city, remaining_hc: job.hc,
        active_state: job.active_state, priority: job.priority ?? null,
        captured_at: job.captured_at,
      },
    };
  });
  const allEvidence = candidates.flatMap((candidate) => candidate.evidence_refs);
  const signalSnapshotId = `signals:${sha256(context.signals.map((signal) => [
    signal.signal_id, signal.algorithm_version, signal.expires_at,
  ])).slice(0, 24)}`;
  const candidateSetRef = `candidates:${sha256(candidates.map((candidate) => [
    candidate.job_id, candidate.job_fact_version, candidate.retrieval_lanes,
  ])).slice(0, 24)}`;
  const coverage = {
    profile: { status: 'available', version: context.profile_version },
    load: { status: 'available', version: context.load.version },
    job_facts: { status: candidates.length ? 'available' : 'missing', count: candidates.length },
    recent_intent: { status: context.signals.length ? 'available' : 'missing', count: context.signals.length },
    delivery_history: { status: db.prepare(`SELECT COUNT(*) n FROM business_outcome_events
      WHERE tenant_id=? AND consultant_id=?`).get(request.tenantId, request.consultantId).n
      ? 'available' : 'missing' },
    talent_supply: { status: supplyIds.size ? 'available' : 'missing' },
    team_scheduling: { status: 'available', version: context.load.version },
  };
  return {
    schema_version: 'ranking-context-v1', run_id: versions.runId,
    generation: versions.generation, tenant_id: request.tenantId,
    consultant_id: request.consultantId, as_of: versions.at,
    received_high_watermark: snapshot.completed_at,
    source_snapshot_ids: [...new Set(candidates.map((item) => item.source_snapshot_id).filter(Boolean))],
    profile_version: context.profile_version, signal_snapshot_id: signalSnapshotId,
    load_version: context.load.version, authorization_version: request.authorizationVersion,
    candidate_set_ref: candidateSetRef,
    job_fact_version_refs: candidates.map((item) => item.job_fact_version),
    evidence_manifest_ref: `evidence:${sha256(allEvidence).slice(0, 24)}`,
    coverage_manifest: coverage, context_registry_version: 'context-registry-v1',
    context_refs: versions.contextRefs || [],
    algorithm_version: 'agentic-ranking-v1', prompt_version: versions.promptVersion,
    tool_schema_version: versions.toolSchemaVersion,
    eligibility_policy_version: versions.eligibilityPolicyVersion,
    diversity_policy_version: versions.diversityPolicyVersion,
    model_id: versions.modelId, model_parameters: versions.modelParameters,
    budget: versions.budget, source_snapshot_id: snapshot.sync_id,
    capacity_blocked: capacityBlocked, eligible_count: eligible.length,
    retrieved_count: candidates.length, candidates,
  };
}

export function frozenInputStillCurrent(db, input, output, currentAuthorizationVersion) {
  const generation = db.prepare(`SELECT current_generation FROM agentic_ranking_generations
    WHERE tenant_id=? AND consultant_id=?`).get(input.tenant_id, input.consultant_id);
  if (generation?.current_generation !== input.generation) return 'STALE_GENERATION';
  if (currentAuthorizationVersion !== input.authorization_version) return 'STALE_AUTHORIZATION';
  const context = currentConsultantContext(db, {
    tenantId: input.tenant_id, consultantId: input.consultant_id,
  });
  if (context.profile_version !== input.profile_version) return 'STALE_PROFILE';
  if (currentProjectLoad(db, input.consultant_id).version !== input.load_version) return 'STALE_LOAD';
  const snapshot = latestRealSync(db, input.consultant_id);
  if (!snapshot?.complete || snapshot.sync_id !== input.source_snapshot_id) return 'STALE_SOURCE';
  const ignored = ignoredProjectIds(db, input.consultant_id);
  const accepted = new Set(db.prepare(`SELECT project_id FROM current_engagement
    WHERE consultant_id=? AND state='ACCEPTED'`).all(input.consultant_id).map((row) => row.project_id));
  const capacity = Number(context.profile.capacity_limit);
  if (Number.isFinite(capacity) && capacity > 0 && context.load.accepted_projects >= capacity) {
    return 'STALE_CAPACITY';
  }
  const candidateMap = new Map(input.candidates.map((item) => [item.job_id, item]));
  for (const item of output.items || []) {
    const job = effectiveJob(db, input.consultant_id, item.job_id);
    if (!job || job.active_state !== 'OPEN' || job.hc === 0
      || !jobVisibleTo(db, input.consultant_id, item.job_id)
      || ignored.has(item.job_id) || accepted.has(item.job_id)
      || excluded(job, context.profile)) return 'STALE_ELIGIBILITY';
    const latest = db.prepare(`SELECT fact_version FROM job_fact_versions
      WHERE tenant_id=? AND job_id=? ORDER BY version DESC LIMIT 1`)
      .get(input.tenant_id, item.job_id);
    if (!latest || latest.fact_version !== candidateMap.get(item.job_id)?.job_fact_version) {
      return 'STALE_JOB_VERSION';
    }
  }
  return null;
}
