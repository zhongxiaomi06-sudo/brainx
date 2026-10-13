/** Agent 模型调用逐尝试账本（specs/030）。不保存 prompt、密钥或完整回复。 */
import { now, uuid } from '../db.js';

function token(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      usage_status: 'UNKNOWN', input_tokens: null, output_tokens: null,
      total_tokens: null, cached_input_tokens: null, reasoning_tokens: null,
    };
  }
  const input = token(usage.input_tokens ?? usage.prompt_tokens);
  const output = token(usage.output_tokens ?? usage.completion_tokens);
  const total = token(usage.total_tokens);
  const cachedRaw = usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_tokens_details?.cached_tokens;
  const reasoningRaw = usage.output_tokens_details?.reasoning_tokens
    ?? usage.completion_tokens_details?.reasoning_tokens;
  const baseKnown = input != null || output != null || total != null;
  const cached = cachedRaw == null && baseKnown ? 0 : token(cachedRaw);
  const reasoning = reasoningRaw == null && baseKnown ? 0 : token(reasoningRaw);
  const known = input != null && output != null && total != null;
  return {
    usage_status: known ? 'KNOWN' : baseKnown ? 'PARTIAL' : 'UNKNOWN',
    input_tokens: input, output_tokens: output, total_tokens: total,
    cached_input_tokens: cached, reasoning_tokens: reasoning,
  };
}

export function aggregateUsageRows(rows) {
  const fields = ['input_tokens', 'output_tokens', 'total_tokens',
    'cached_input_tokens', 'reasoning_tokens'];
  const out = {
    calls: rows.length,
    known_calls: rows.filter((row) => row.usage_status === 'KNOWN').length,
  };
  for (const field of fields) {
    out[field] = rows.length > 0 && rows.every((row) => row[field] != null)
      ? rows.reduce((sum, row) => sum + Number(row[field]), 0)
      : null;
  }
  return out;
}

function cleanCode(error) {
  const raw = String(error?.code || error?.name || 'MODEL_ERROR').toUpperCase();
  return raw.replace(/[^A-Z0-9_:-]/g, '_').slice(0, 80);
}

export function createUsageRecorder(db, defaults) {
  const startedMs = new Map();
  function start({ round, attempt, requestRef = null, contextRefs = [] }) {
    const callId = `auc_${uuid()}`;
    const startedAt = now();
    startedMs.set(callId, Date.now());
    db.prepare(`INSERT INTO agent_usage_calls
      (call_id, run_id, tenant_id, consultant_id, round, attempt, provider_id,
       model_id, request_ref, status, usage_status, context_refs_json, started_at)
      VALUES (?,?,?,?,?,?,?,?,?,'PENDING','UNKNOWN',?,?)`).run(
      callId, defaults.runId, defaults.tenantId, defaults.consultantId,
      round, attempt, defaults.providerId, defaults.modelId, requestRef,
      JSON.stringify([...new Set(contextRefs.map(String))]), startedAt,
    );
    return callId;
  }

  function finish(callId, { status, usage = null, error = null, toolCount = 0,
    priceVersion = null, estimatedCostMicros = null, currency = null } = {}) {
    const normalized = normalizeUsage(usage);
    const latency = Math.max(0, Date.now() - (startedMs.get(callId) || Date.now()));
    startedMs.delete(callId);
    db.prepare(`UPDATE agent_usage_calls SET
      status=?, usage_status=?, input_tokens=?, output_tokens=?, total_tokens=?,
      cached_input_tokens=?, reasoning_tokens=?, price_version=?, estimated_cost_micros=?,
      currency=?, latency_ms=?, tool_count=?, error_code=?, completed_at=?
      WHERE call_id=? AND status='PENDING'`).run(
      status, normalized.usage_status, normalized.input_tokens, normalized.output_tokens,
      normalized.total_tokens, normalized.cached_input_tokens, normalized.reasoning_tokens,
      priceVersion ?? defaults.priceVersion ?? null, estimatedCostMicros,
      currency ?? defaults.currency ?? null, latency, Number(toolCount) || 0,
      error ? cleanCode(error) : null, now(), callId,
    );
  }

  function aggregate() {
    const rows = db.prepare(`SELECT usage_status, input_tokens, output_tokens, total_tokens,
      cached_input_tokens, reasoning_tokens FROM agent_usage_calls
      WHERE tenant_id=? AND run_id=? ORDER BY round, attempt`)
      .all(defaults.tenantId, defaults.runId);
    return aggregateUsageRows(rows);
  }

  return { start, finish, aggregate, runId: defaults.runId };
}
