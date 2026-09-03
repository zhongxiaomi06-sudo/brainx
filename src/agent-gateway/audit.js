import { createHmac, randomUUID } from 'node:crypto';
import { hashArguments } from './assertion.js';

function iso(options) {
  const now = options?.now instanceof Date ? options.now : new Date(options?.now || Date.now());
  return now.toISOString();
}

function auditHash(value, auditKey) {
  const key = Buffer.from(String(auditKey || ''), 'utf8');
  if (key.length < 32) throw Object.assign(new Error('AUDIT_KEY_INVALID'), { code: 'INTERNAL' });
  return createHmac('sha256', key).update(String(value || ''), 'utf8').digest('hex');
}

function safeRef(value) {
  if (value === null || value === undefined) return null;
  return String(value).slice(0, 128);
}

export function beginAgentRun(db, payload, options = {}) {
  const runId = options.runId || randomUUID();
  const at = iso(options);
  db.prepare(`INSERT INTO agent_runs
    (run_id, request_id, channel, account_id, chat_type, sender_hash, chat_id_hash,
     purpose, tool_name, status, model_ref, skill_version, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?)`).run(
    runId, payload.request_id, payload.channel, payload.account_id, payload.chat_type,
    auditHash(payload.requester_sender_id, options.auditKey),
    auditHash(payload.chat_id, options.auditKey), payload.purpose, payload.tool_name,
    safeRef(options.modelRef), safeRef(options.skillVersion), at,
  );
  return runId;
}

export function authorizeAgentRun(db, runId, principal) {
  const result = db.prepare(`UPDATE agent_runs SET tenant_id=?, consultant_id=?, status='AUTHORIZED'
    WHERE run_id=? AND status='RECEIVED'`).run(principal.tenantId, principal.consultantId, runId);
  if (result.changes !== 1) throw Object.assign(new Error('AUDIT_STATE_INVALID'), { code: 'INTERNAL' });
}

export function beginToolCall(db, input, options = {}) {
  const toolCallId = options.toolCallId || randomUUID();
  const keys = input.arguments && typeof input.arguments === 'object' && !Array.isArray(input.arguments)
    ? Object.keys(input.arguments).sort() : [];
  db.prepare(`INSERT INTO agent_tool_calls
    (tool_call_id, run_id, tool_name, tool_version, arguments_hash, arguments_summary_json,
     authorization_result, policy_version, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'ALLOWED', ?, 'STARTED', ?)`).run(
    toolCallId, input.runId, input.toolName, input.toolVersion,
    hashArguments(input.arguments), JSON.stringify({ provided_keys: keys }), input.policyVersion, iso(options),
  );
  return toolCallId;
}

export function finishToolCall(db, toolCallId, result, options = {}) {
  if (!['SUCCEEDED', 'REFUSED', 'FAILED'].includes(result.status)) {
    throw Object.assign(new Error('AUDIT_STATE_INVALID'), { code: 'INTERNAL' });
  }
  const completedAt = iso(options);
  const row = db.prepare('SELECT created_at FROM agent_tool_calls WHERE tool_call_id=?').get(toolCallId);
  if (!row) throw Object.assign(new Error('AUDIT_STATE_INVALID'), { code: 'INTERNAL' });
  const duration = Math.max(0, new Date(completedAt).getTime() - new Date(row.created_at).getTime());
  const update = db.prepare(`UPDATE agent_tool_calls
    SET status=?, duration_ms=?, error_code=?, data_versions_json=?, evidence_refs_json=?, completed_at=?
    WHERE tool_call_id=? AND status='STARTED'`).run(
    result.status, duration, safeRef(result.errorCode), JSON.stringify(result.dataVersions || {}),
    JSON.stringify(result.evidenceRefs || []), completedAt, toolCallId,
  );
  if (update.changes !== 1) throw Object.assign(new Error('AUDIT_STATE_INVALID'), { code: 'INTERNAL' });
}

export function finishAgentRun(db, runId, result, options = {}) {
  if (!['SUCCEEDED', 'REFUSED', 'FAILED'].includes(result.status)) {
    throw Object.assign(new Error('AUDIT_STATE_INVALID'), { code: 'INTERNAL' });
  }
  const update = db.prepare(`UPDATE agent_runs SET status=?, error_code=?, completed_at=?
    WHERE run_id=? AND status IN ('RECEIVED','AUTHORIZED')`).run(
    result.status, safeRef(result.errorCode), iso(options), runId,
  );
  if (update.changes !== 1) throw Object.assign(new Error('AUDIT_STATE_INVALID'), { code: 'INTERNAL' });
}
