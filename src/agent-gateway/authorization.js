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
  const projects = parseStringArray(scopes[0].project_refs_json);
  // 2026-09-15 用户决策：不再按 allowed_senders 限制——已绑定群的 ACTIVE scope 即信任边界，
  // 群里任何已登记顾问都能点找人/候选动作（发送人身份由 resolveBinding 兜底）。
  if (!purposes.includes(payload.purpose)) fail();
  if (projectRef !== null && !projects.includes(projectRef)) fail();
}

/**
 * specs/015：旧群绑定工具的特例放行。群尚未登记 agent_group_scopes，靠 bot_chat_intake
 * 卡口 + 已登记顾问身份放行；只此一个工具（brainx_bind_group_project）走这条路。
 * 2026-09-15：轮询未登记的群不再授权层硬拒（基线抑制/静默失败/10 分钟窗口都会让表为空），
 * 放行到 handler 由 bindGroupToProject 实时核对机器人在群并补登记（自愈）。
 */
function authorizeIntakeBinding(db, payload, binding) {
  if (payload.purpose !== 'group_binding') fail();
  const intake = db.prepare(`SELECT status FROM bot_chat_intake WHERE chat_id=?`).get(payload.chat_id);
  if (!intake) return;
  if (intake.status === 'BOUND') fail('GROUP_ALREADY_BOUND');
  if (!['SEEN', 'CARD_SENT'].includes(intake.status)) fail('GROUP_NOT_INTAKED');
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
  if (options.requireP2p && payload.chat_type !== 'p2p') fail();
  // specs/017：群绑定只在群里成立——私聊里 chat_id 是顾问本人的 open_id，永远不在 bot_chat_intake 里，
  // 放行到 handler 只会拿到一个业务层错误。这里早失败，直接给出「先拉机器人进群再点卡」的指引。
  if (options.allowIntakeBinding && payload.chat_type !== 'group') fail('GROUP_REQUIRED');
  if (payload.chat_type === 'p2p') {
    if (payload.chat_id !== payload.requester_sender_id) fail();
  } else if (options.allowIntakeBinding) {
    authorizeIntakeBinding(db, payload, binding);
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
