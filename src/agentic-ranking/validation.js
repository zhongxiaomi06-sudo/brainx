/** agentic-ranking-v1 最终输出校验：只判合法性，不评分、不重排、不补齐。 */
const TOP_KEYS = new Set([
  'schema_version', 'run_id', 'decision', 'items', 'not_selected',
  'missing_information', 'stop_reason',
]);
const ITEM_KEYS = new Set([
  'job_id', 'job_fact_version', 'rank', 'decision_tier', 'reason_codes',
  'reason', 'tradeoff', 'evidence_refs', 'uncertainties', 'suggested_next_action',
]);
const TIERS = new Set(['TODAY', 'EXPLORE', 'MONITOR']);
const NOT_SELECTED_KEYS = new Set(['job_id', 'reason']);

function exactKeys(value, allowed, path, errors) {
  for (const key of Object.keys(value || {})) {
    if (!allowed.has(key)) errors.push(`${path}.UNKNOWN_FIELD:${key}`);
  }
}

function string(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function strings(value, maxItems, maxLength, { allowEmpty = true } = {}) {
  return Array.isArray(value) && value.length <= maxItems
    && (allowEmpty || value.length > 0)
    && value.every((item) => string(item, maxLength));
}

function validateNotSelected(entries, candidates, selected, errors) {
  if (entries.length > candidates.size) errors.push('NOT_SELECTED_TOO_LARGE');
  const seen = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const path = `not_selected[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${path}.NOT_OBJECT`);
      continue;
    }
    exactKeys(entry, NOT_SELECTED_KEYS, path, errors);
    if (!string(entry.job_id, 200) || !candidates.has(entry.job_id)) {
      errors.push(`${path}.JOB_NOT_ELIGIBLE`);
    }
    if (selected.has(entry.job_id) || seen.has(entry.job_id)) errors.push(`${path}.JOB_DUPLICATE`);
    seen.add(entry.job_id);
    if (!string(entry.reason, 300)) errors.push(`${path}.REASON_INVALID`);
  }
}

export function parseAgentOutput(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function validateAgentOutput(output, input) {
  const errors = [];
  if (!output) return ['OUTPUT_NOT_JSON_OBJECT'];
  exactKeys(output, TOP_KEYS, 'output', errors);
  if (output.schema_version !== 'agentic-ranking-v1') errors.push('SCHEMA_VERSION_INVALID');
  if (output.run_id !== input.run_id) errors.push('RUN_ID_MISMATCH');
  if (!['RECOMMEND', 'ABSTAIN'].includes(output.decision)) errors.push('DECISION_INVALID');
  if (!Array.isArray(output.items)) errors.push('ITEMS_NOT_ARRAY');
  if (!Array.isArray(output.not_selected)) errors.push('NOT_SELECTED_NOT_ARRAY');
  if (!strings(output.missing_information, 50, 500)) errors.push('MISSING_INFORMATION_INVALID');
  if (!string(output.stop_reason, 120)) errors.push('STOP_REASON_INVALID');
  if (errors.length || !Array.isArray(output.items)) return errors;
  const candidates = new Map(input.candidates.map((item) => [item.job_id, item]));
  if (output.decision === 'ABSTAIN') {
    if (output.items.length !== 0) errors.push('ABSTAIN_ITEMS_NOT_EMPTY');
    validateNotSelected(output.not_selected, candidates, new Set(), errors);
    return errors;
  }
  if (output.items.length < 1 || output.items.length > input.budget.maxItems) {
    errors.push('ITEM_COUNT_INVALID');
  }
  const jobs = new Set();
  for (let index = 0; index < output.items.length; index++) {
    const item = output.items[index];
    const path = `items[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${path}.NOT_OBJECT`);
      continue;
    }
    exactKeys(item, ITEM_KEYS, path, errors);
    if (!string(item.job_id, 200)) errors.push(`${path}.JOB_ID_INVALID`);
    if (jobs.has(item.job_id)) errors.push(`${path}.JOB_DUPLICATE`);
    jobs.add(item.job_id);
    const candidate = candidates.get(item.job_id);
    if (!candidate) errors.push(`${path}.JOB_NOT_ELIGIBLE`);
    if (!string(item.job_fact_version, 200)
      || candidate?.job_fact_version !== item.job_fact_version) {
      errors.push(`${path}.FACT_VERSION_INVALID`);
    }
    if (item.rank !== index + 1) errors.push(`${path}.RANK_NOT_CONTIGUOUS`);
    if (!TIERS.has(item.decision_tier)) errors.push(`${path}.TIER_INVALID`);
    if (!strings(item.reason_codes, 10, 80, { allowEmpty: false })
      || item.reason_codes?.some((code) => !/^[A-Z0-9_:-]+$/.test(code))) {
      errors.push(`${path}.REASON_CODES_INVALID`);
    }
    if (!string(item.reason, 600)) errors.push(`${path}.REASON_INVALID`);
    if (!string(item.tradeoff, 600)) errors.push(`${path}.TRADEOFF_INVALID`);
    if (!strings(item.uncertainties, 20, 300)) errors.push(`${path}.UNCERTAINTIES_INVALID`);
    if (!string(item.suggested_next_action, 300)) errors.push(`${path}.NEXT_ACTION_INVALID`);
    if (!strings(item.evidence_refs, 20, 200, { allowEmpty: false })) {
      errors.push(`${path}.EVIDENCE_REFS_INVALID`);
    } else {
      const allowed = new Set(candidate?.evidence_refs || []);
      if (item.evidence_refs.some((ref) => !allowed.has(ref))) {
        errors.push(`${path}.EVIDENCE_NOT_AUTHORIZED`);
      }
    }
  }
  validateNotSelected(output.not_selected, candidates, jobs, errors);
  return [...new Set(errors)];
}
