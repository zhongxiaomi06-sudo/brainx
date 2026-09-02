import { createHash } from 'node:crypto';
import { AGENT_TOOL_ROWS } from './tool-registry.js';

const TOOL_PURPOSES = Object.freeze(Object.fromEntries(
  AGENT_TOOL_ROWS.map((row) => [row.name, row.purpose]),
));

export class AgentAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AgentAuthorizationError';
    this.code = code;
  }
}

function fail(code = 'NOT_FOUND_OR_FORBIDDEN') {
  throw new AgentAuthorizationError(code);
}

export function hashFeishuAppKey(appKey) {
  if (typeof appKey !== 'string' || !appKey || appKey.length > 512) fail('UNBOUND_IDENTITY');
  return createHash('sha256').update(appKey, 'utf8').digest('hex');
}

function parseStringArray(raw) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) fail();
    return value;
  } catch {
    fail();
  }
}

function validText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function resolveBinding(db, payload, feishuAppKeyHash) {
  if (!/^[a-f0-9]{64}$/.test(String(feishuAppKeyHash || ''))) fail('UNBOUND_IDENTITY');
  const binding = db.prepare(`SELECT b.tenant_id, b.consultant_id, b.feishu_app_key_hash
    FROM feishu_identity_bindings b
    JOIN consultants c ON c.consultant_id=b.consultant_id AND c.active=1
    WHERE b.channel_account_id=? AND b.open_id=? AND b.binding_status='ACTIVE'
    LIMIT 2`).all(payload.account_id, payload.requester_sender_id);
  if (binding.length !== 1 || binding[0].feishu_app_key_hash !== feishuAppKeyHash) {
    fail('UNBOUND_IDENTITY');
  }
  return binding[0];
}

function authorizeGroup(db, payload, binding, projectRef) {
  const scopes = db.prepare(`SELECT allowed_purposes_json, allowed_senders_json, project_refs_json
    FROM agent_group_scopes
    WHERE tenant_id=? AND channel_account_id=? AND chat_id=? AND scope_status='ACTIVE'
    LIMIT 2`).all(binding.tenant_id, payload.account_id, payload.chat_id);
  if (scopes.length !== 1) fail();
  const purposes = parseStringArray(scopes[0].allowed_purposes_json);
  const senders = parseStringArray(scopes[0].allowed_senders_json);
  const projects = parseStringArray(scopes[0].project_refs_json);
  if (!purposes.includes(payload.purpose) || !senders.includes(payload.requester_sender_id)) fail();
  if (projectRef !== null && !projects.includes(projectRef)) fail();
}

export function authorizePrincipal(db, payload, options = {}) {
  if (!db || !payload || payload.channel !== 'feishu'
      || !validText(payload.account_id) || !validText(payload.requester_sender_id)
      || !validText(payload.chat_id) || !validText(payload.purpose) || !validText(payload.tool_name)
      || !['p2p', 'group'].includes(payload.chat_type)) {
    fail('UNBOUND_IDENTITY');
  }
  const allowedPurposes = TOOL_PURPOSES[payload.tool_name];
  if (!allowedPurposes?.includes(payload.purpose)) fail();
  const projectRef = options.projectRef ?? null;
  if (projectRef !== null && !validText(projectRef)) fail();
  const binding = resolveBinding(db, payload, options.feishuAppKeyHash);
  if (payload.chat_type === 'p2p') {
    if (payload.chat_id !== payload.requester_sender_id) fail();
  } else {
    if (options.requireProjectScope && projectRef === null) fail();
    authorizeGroup(db, payload, binding, projectRef);
  }
  return Object.freeze({
    tenantId: binding.tenant_id,
    consultantId: binding.consultant_id,
    accountId: payload.account_id,
    senderId: payload.requester_sender_id,
    chatType: payload.chat_type,
    chatId: payload.chat_id,
    purpose: payload.purpose,
  });
}

export function purposesForTool(toolName) {
  return TOOL_PURPOSES[toolName] ? [...TOOL_PURPOSES[toolName]] : [];
}
