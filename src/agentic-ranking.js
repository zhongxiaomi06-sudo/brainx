/** 默认关闭的 agentic-ranking-v1 最小链路；与 baseline-1.1 表和正式读路径分离。 */
import { now, uuid } from './db.js';
import { createRankingToolRegistry } from './agent/ranking-tools.js';
import { createUsageRecorder } from './agent/usage-ledger.js';
import { linkRunContext, readContext } from './context-registry.js';
import { appendConsultantProfileVersion, canonicalActiveProfile } from './profile-outcome-ledger.js';
import { buildFrozenRankingInput, frozenInputStillCurrent } from './agentic-ranking/input.js';
import { parseAgentOutput, validateAgentOutput } from './agentic-ranking/validation.js';

export const AGENTIC_RANKING_VERSION = 'agentic-ranking-v1';

function integer(value, fallback, minimum, maximum) {
  return Number.isInteger(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function budgetOf(request) {
  const raw = request.budget || {};
  return {
    maxCalls: integer(raw.maxCalls, 3, 1, 3),
    maxTotalTokens: integer(raw.maxTotalTokens, 20_000, 1, 1_000_000),
    maxItems: integer(raw.maxItems ?? request.maxItems, 20, 1, 20),
    maxRepairs: 2,
  };
}

function codeOf(error) {
  if (error?.name === 'AbortError') return 'AGENT_CANCELLED';
  return String(error?.code || 'AGENT_CALL_FAILED').replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 80);
}

function safeJson(value) {
  try { return JSON.stringify(value); } catch { return null; }
}

function ensureProfileVersion(db, request, at) {
  const latest = db.prepare(`SELECT profile_version FROM consultant_profile_versions
    WHERE tenant_id=? AND consultant_id=? ORDER BY version DESC LIMIT 1`)
    .get(request.tenantId, request.consultantId);
  if (latest) return latest.profile_version;
  const row = db.prepare(`SELECT profile_json FROM consultants
    WHERE consultant_id=? AND active=1`).get(request.consultantId);
  if (!row) throw Object.assign(new Error('CONSULTANT_NOT_FOUND'), { code: 'CONSULTANT_NOT_FOUND' });
  let profile = {};
  try { profile = JSON.parse(row.profile_json || '{}'); } catch { /* 空画像 */ }
  return appendConsultantProfileVersion(db, {
    tenantId: request.tenantId, consultantId: request.consultantId,
    profile: canonicalActiveProfile(profile), changedBy: 'agentic-ranking-bootstrap',
    reason: 'LEGACY_PROFILE_BOOTSTRAP', at,
  }).profile_version;
}

function beginRun(db, request, versions) {
  db.exec('BEGIN');
  try {
    ensureProfileVersion(db, request, versions.at);
    const current = db.prepare(`SELECT current_generation FROM agentic_ranking_generations
      WHERE tenant_id=? AND consultant_id=?`).get(request.tenantId, request.consultantId);
    const generation = (current?.current_generation || 0) + 1;
    db.prepare(`INSERT INTO agentic_ranking_generations
      (tenant_id, consultant_id, current_generation, updated_at) VALUES (?,?,?,?)
      ON CONFLICT(tenant_id,consultant_id) DO UPDATE SET
        current_generation=excluded.current_generation, updated_at=excluded.updated_at`)
      .run(request.tenantId, request.consultantId, generation, versions.at);
    const input = buildFrozenRankingInput(db, request, { ...versions, generation });
    db.prepare(`INSERT INTO agentic_ranking_runs
      (run_id, tenant_id, consultant_id, generation, status, run_mode, algorithm_version,
       source_snapshot_id, profile_version, signal_snapshot_id, load_version,
       authorization_version, candidate_set_ref, model_id, prompt_version,
       tool_schema_version, eligibility_policy_version, diversity_policy_version,
       budget_json, input_json, eligible_count, retrieved_count, created_at)
      VALUES (?,?,?,?,'RUNNING',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      versions.runId, request.tenantId, request.consultantId, generation,
      versions.runMode, AGENTIC_RANKING_VERSION, input.source_snapshot_id, input.profile_version,
      input.signal_snapshot_id, input.load_version, input.authorization_version,
      input.candidate_set_ref, versions.modelId, versions.promptVersion,
      versions.toolSchemaVersion, versions.eligibilityPolicyVersion,
      versions.diversityPolicyVersion, JSON.stringify(versions.budget),
      JSON.stringify(input), input.eligible_count, input.retrieved_count, versions.at,
    );
    for (const contextId of input.context_refs) {
      linkRunContext(db, { runId: versions.runId, contextId, accessedAt: versions.at });
    }
    if (!input.candidates.length) {
      const output = {
        schema_version: AGENTIC_RANKING_VERSION, run_id: versions.runId,
        decision: 'ABSTAIN', items: [], not_selected: [],
        missing_information: [],
        stop_reason: input.capacity_blocked ? 'CAPACITY_REACHED' : 'NO_ELIGIBLE_CANDIDATES',
      };
      db.prepare(`UPDATE agentic_ranking_runs SET status='ABSTAINED', output_json=?,
        finished_at=? WHERE run_id=?`).run(JSON.stringify(output), versions.at, versions.runId);
    }
    db.exec('COMMIT');
    return input;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function terminal(db, runId, status, { output = null, errors = [], repairCount = 0,
  toolCallCount = 0, failureCode = null, at = now() } = {}) {
  db.prepare(`UPDATE agentic_ranking_runs SET status=?, output_json=?,
    validation_errors_json=?, repair_count=?, tool_call_count=?, failure_code=?, finished_at=?
    WHERE run_id=?`).run(status, safeJson(output), JSON.stringify(errors), repairCount,
    toolCallCount, failureCode, at, runId);
}

function publicItem(row) {
  return {
    decision_id: row.decision_id, job_id: row.job_id,
    job_fact_version: row.job_fact_version, rank: row.rank,
    decision_tier: row.decision_tier, reason_codes: JSON.parse(row.reason_codes_json),
    reason: row.reason, tradeoff: row.tradeoff,
    evidence_refs: JSON.parse(row.evidence_refs_json),
    uncertainties: JSON.parse(row.uncertainties_json),
    suggested_next_action: row.suggested_next_action,
  };
}

function resultFor(db, runId) {
  const run = db.prepare('SELECT * FROM agentic_ranking_runs WHERE run_id=?').get(runId);
  const items = db.prepare(`SELECT * FROM agentic_ranking_items
    WHERE run_id=? ORDER BY rank`).all(runId).map(publicItem);
  return { run_id: runId, generation: run.generation, status: run.status,
    run_mode: run.run_mode,
    repair_count: run.repair_count, failure_code: run.failure_code, items };
}

function publish(db, input, output, dependencies, counters) {
  db.exec('BEGIN');
  try {
    const auth = dependencies.currentAuthorizationVersionFn({
      tenantId: input.tenant_id, consultantId: input.consultant_id,
    });
    const stale = frozenInputStillCurrent(db, input, output, auth);
    if (stale) {
      terminal(db, input.run_id, 'STALE', {
        output, repairCount: counters.repairCount, toolCallCount: counters.toolCallCount,
        failureCode: stale, at: dependencies.nowFn(),
      });
      db.exec('COMMIT');
      return;
    }
    if (output.decision === 'ABSTAIN') {
      terminal(db, input.run_id, 'ABSTAINED', {
        output, repairCount: counters.repairCount,
        toolCallCount: counters.toolCallCount, at: dependencies.nowFn(),
      });
      db.exec('COMMIT');
      return;
    }
    const insert = db.prepare(`INSERT INTO agentic_ranking_items
      (decision_id, run_id, tenant_id, consultant_id, job_id, job_fact_version,
       rank, decision_tier, reason_codes_json, reason, tradeoff, evidence_refs_json,
       uncertainties_json, suggested_next_action, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const item of output.items) {
      insert.run(`ard_${dependencies.idFn()}`, input.run_id, input.tenant_id,
        input.consultant_id, item.job_id, item.job_fact_version, item.rank,
        item.decision_tier, JSON.stringify(item.reason_codes), item.reason,
        item.tradeoff, JSON.stringify(item.evidence_refs),
        JSON.stringify(item.uncertainties), item.suggested_next_action, dependencies.nowFn());
    }
    terminal(db, input.run_id, 'PUBLISHED', {
      output, repairCount: counters.repairCount,
      toolCallCount: counters.toolCallCount, at: dependencies.nowFn(),
    });
    db.prepare(`UPDATE agentic_ranking_runs SET reviewed_count=? WHERE run_id=?`)
      .run(output.items.length + (output.not_selected?.length || 0), input.run_id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function runAgenticRanking(db, request, options = {}) {
  const enabled = options.enabled ?? process.env.BRAINX_AGENTIC_RANKING === '1';
  if (!enabled) return { disabled: true, engine: AGENTIC_RANKING_VERSION };
  if (!request?.tenantId || !request?.consultantId || !request?.authorizationVersion) {
    throw new TypeError('Algorithm A 请求缺少租户、顾问或授权版本');
  }
  const dependencies = {
    agentFn: options.agentFn,
    idFn: options.idFn || uuid,
    nowFn: options.nowFn || now,
    modelId: options.modelId || 'unconfigured-model',
    providerId: options.providerId || 'unconfigured-provider',
    promptVersion: options.promptVersion || 'agentic-ranking-prompt-v1',
    toolSchemaVersion: options.toolSchemaVersion || 'ranking-tools-v1',
    eligibilityPolicyVersion: options.eligibilityPolicyVersion || 'eligibility-v1',
    diversityPolicyVersion: options.diversityPolicyVersion || 'diversity-v1',
    modelParameters: options.modelParameters || {},
    currentAuthorizationVersionFn: options.currentAuthorizationVersionFn
      || (() => request.authorizationVersion),
    supplySummaryFn: options.supplySummaryFn || null,
    runMode: options.runMode === 'SHADOW' ? 'SHADOW' : 'LIVE',
  };
  const runId = `arr_${dependencies.idFn()}`;
  const budget = budgetOf(request);
  const at = dependencies.nowFn();
  let registeredContexts;
  try {
    const contextIds = Array.isArray(options.contextRefs) ? options.contextRefs : [];
    registeredContexts = [...new Set(contextIds.map(String))].slice(0, 20)
      .map((contextId) => readContext(db, {
        contextId, tenantId: request.tenantId, consultantId: request.consultantId,
        purpose: 'ranking', projectIds: options.contextProjectIds || [], at,
      }));
  } catch (error) {
    return { status: 'FAILED', run_id: null, failure_code: codeOf(error), items: [] };
  }
  const supplyJobIds = options.supplyRecallFn
    ? await options.supplyRecallFn({ tenantId: request.tenantId,
      consultantId: request.consultantId, authorizationVersion: request.authorizationVersion })
    : [];
  let input;
  try {
    input = beginRun(db, request, { ...dependencies, runId, budget, at,
      contextRefs: registeredContexts.map((context) => context.context_id),
      supplyJobIds: Array.isArray(supplyJobIds) ? supplyJobIds : [] });
  } catch (error) {
    return { status: 'FAILED', run_id: null, failure_code: codeOf(error), items: [] };
  }
  if (!input.candidates.length) return resultFor(db, runId);
  if (typeof dependencies.agentFn !== 'function') {
    terminal(db, runId, 'FAILED', { failureCode: 'AGENT_DECIDER_REQUIRED', at: dependencies.nowFn() });
    return resultFor(db, runId);
  }
  const registry = createRankingToolRegistry({
    db, principal: { tenantId: request.tenantId, consultantId: request.consultantId,
      authorizationVersion: request.authorizationVersion },
    supplySummaryFn: dependencies.supplySummaryFn,
  });
  let toolCallCount = 0;
  const callTool = async (name, args, callOptions) => {
    toolCallCount += 1;
    return registry.call(name, args, callOptions);
  };
  const recorder = createUsageRecorder(db, {
    runId, tenantId: request.tenantId, consultantId: request.consultantId,
    providerId: dependencies.providerId, modelId: dependencies.modelId,
  });
  let errors = [];
  let lastOutput = null;
  for (let callIndex = 1; callIndex <= budget.maxCalls; callIndex++) {
    const aggregate = recorder.aggregate();
    if (aggregate.total_tokens != null && aggregate.total_tokens >= budget.maxTotalTokens) {
      terminal(db, runId, 'FAILED', { output: lastOutput, errors,
        repairCount: callIndex - 1, toolCallCount,
        failureCode: 'AGENT_BUDGET_EXHAUSTED', at: dependencies.nowFn() });
      return resultFor(db, runId);
    }
    const callId = recorder.start({
      round: callIndex, attempt: 1, contextRefs: input.context_refs,
    });
    let reply;
    try {
      reply = await dependencies.agentFn({
        input, tools: registry.tools(), callTool,
        registeredContexts,
        validationErrors: errors, repairCount: callIndex - 1,
      });
      recorder.finish(callId, {
        status: reply?.cacheHit ? 'CACHED' : 'SUCCEEDED', usage: reply?.usage,
        toolCount: toolCallCount, priceVersion: reply?.priceVersion,
        estimatedCostMicros: reply?.estimatedCostMicros, currency: reply?.currency,
      });
    } catch (error) {
      const cancelled = error?.name === 'AbortError';
      recorder.finish(callId, { status: cancelled ? 'CANCELLED' : 'FAILED', error });
      terminal(db, runId, cancelled ? 'CANCELLED' : 'FAILED', {
        errors, repairCount: callIndex - 1, toolCallCount,
        failureCode: codeOf(error), at: dependencies.nowFn(),
      });
      return resultFor(db, runId);
    }
    lastOutput = parseAgentOutput(reply?.output);
    errors = validateAgentOutput(lastOutput, input);
    db.prepare(`UPDATE agentic_ranking_runs SET status='VALIDATING', output_json=?,
      validation_errors_json=?, repair_count=?, tool_call_count=? WHERE run_id=?`)
      .run(safeJson(lastOutput), JSON.stringify(errors), callIndex - 1, toolCallCount, runId);
    if (!errors.length) {
      try {
        publish(db, input, lastOutput, dependencies,
          { repairCount: callIndex - 1, toolCallCount });
      } catch (error) {
        terminal(db, runId, 'FAILED', { output: lastOutput, errors,
          repairCount: callIndex - 1, toolCallCount,
          failureCode: 'PUBLISH_FAILED', at: dependencies.nowFn() });
      }
      return resultFor(db, runId);
    }
  }
  const exhaustedByCalls = budget.maxCalls <= budget.maxRepairs;
  terminal(db, runId, 'FAILED', { output: lastOutput, errors,
    repairCount: Math.max(0, budget.maxCalls - 1), toolCallCount,
    failureCode: exhaustedByCalls ? 'AGENT_BUDGET_EXHAUSTED' : 'OUTPUT_VALIDATION_FAILED',
    at: dependencies.nowFn() });
  return resultFor(db, runId);
}

export function replayAgenticRanking(db, { tenantId, consultantId, runId }) {
  const run = db.prepare(`SELECT * FROM agentic_ranking_runs
    WHERE tenant_id=? AND consultant_id=? AND run_id=?`).get(tenantId, consultantId, runId);
  if (!run) return null;
  return {
    run, input: JSON.parse(run.input_json),
    output: run.output_json ? JSON.parse(run.output_json) : null,
    items: db.prepare(`SELECT * FROM agentic_ranking_items WHERE run_id=? ORDER BY rank`)
      .all(runId).map(publicItem),
  };
}
