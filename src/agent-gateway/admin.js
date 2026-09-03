import { createHmac, randomUUID } from 'node:crypto';
import { AGENT_TOOL_ROWS } from './tool-registry.js';

const PURPOSES = new Set(AGENT_TOOL_ROWS.flatMap((row) => row.purpose));

export class AgentAdminError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AgentAdminError';
    this.code = code;
  }
}

function fail(code) {
  throw new AgentAdminError(code);
}

function adminContext(options) {
  if (typeof options?.actor !== 'string' || !Array.isArray(options.allowedAdmins)
      || !options.allowedAdmins.includes(options.actor)) fail('ADMIN_FORBIDDEN');
  const key = Buffer.from(String(options.auditKey || ''), 'utf8');
  if (key.length < 32) fail('ADMIN_CONFIG_INVALID');
  return { actor: options.actor, key };
}

function text(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function stringList(value, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
      || value.length > 100 || value.some((item) => !text(item))) fail('ADMIN_INPUT_INVALID');
  return [...new Set(value)].sort();
}

function keyedHash(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function recordEvent(db, context, { action, kind, target, result, detail = {} }, at) {
  db.prepare(`INSERT INTO agent_admin_events
    (event_id, action, actor_hash, target_kind, target_hash, result, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    randomUUID(), action, keyedHash(context.key, context.actor), kind,
    keyedHash(context.key, target), result, JSON.stringify(detail), at,
  );
}

function transact(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function bindIdentity(db, input, options) {
  const admin = adminContext(options);
  if (![input.tenantId, input.accountId, input.openId, input.consultantId].every(text)
      || !/^[a-f0-9]{64}$/.test(String(input.feishuAppKeyHash || ''))) fail('ADMIN_INPUT_INVALID');
  return transact(db, () => {
    const consultant = db.prepare('SELECT active FROM consultants WHERE consultant_id=?').get(input.consultantId);
    if (!consultant?.active) fail('ADMIN_INPUT_INVALID');
    const existing = db.prepare(`SELECT * FROM feishu_identity_bindings
      WHERE channel_account_id=? AND open_id=? AND binding_status='ACTIVE'`).get(input.accountId, input.openId);
    if (existing) {
      if (existing.tenant_id !== input.tenantId || existing.consultant_id !== input.consultantId
          || existing.feishu_app_key_hash !== input.feishuAppKeyHash) fail('IDENTITY_CONFLICT');
      return { bindingId: existing.binding_id, status: 'ACTIVE', already: true };
    }
    const at = new Date().toISOString();
    const bindingId = randomUUID();
    const actorHash = keyedHash(admin.key, admin.actor);
    db.prepare(`INSERT INTO feishu_identity_bindings
      (binding_id, tenant_id, channel_account_id, feishu_app_key_hash, open_id, consultant_id,
       employee_ref, binding_status, verified_at, verified_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?)`).run(
      bindingId, input.tenantId, input.accountId, input.feishuAppKeyHash, input.openId,
      input.consultantId, input.employeeRef || null, at, actorHash, at, at,
    );
    recordEvent(db, admin, { action: 'BIND_IDENTITY', kind: 'IDENTITY', target: `${input.accountId}\0${input.openId}`, result: 'APPLIED' }, at);
    return { bindingId, status: 'ACTIVE', already: false };
  });
}

export function revokeIdentity(db, input, options) {
  const admin = adminContext(options);
  if (![input.accountId, input.openId].every(text)) fail('ADMIN_INPUT_INVALID');
  return transact(db, () => {
    const at = new Date().toISOString();
    const row = db.prepare(`SELECT binding_id FROM feishu_identity_bindings
      WHERE channel_account_id=? AND open_id=? AND binding_status='ACTIVE'`).get(input.accountId, input.openId);
    if (!row) fail('ADMIN_TARGET_NOT_FOUND');
    db.prepare(`UPDATE feishu_identity_bindings SET binding_status='REVOKED', revoked_at=?, updated_at=?
      WHERE binding_id=?`).run(at, at, row.binding_id);
    recordEvent(db, admin, { action: 'REVOKE_IDENTITY', kind: 'IDENTITY', target: `${input.accountId}\0${input.openId}`, result: 'UPDATED' }, at);
    return { bindingId: row.binding_id, status: 'REVOKED' };
  });
}

export function grantGroupScope(db, input, options) {
  const admin = adminContext(options);
  if (![input.tenantId, input.accountId, input.chatId].every(text)) fail('ADMIN_INPUT_INVALID');
  const purposes = stringList(input.allowedPurposes);
  const senders = stringList(input.allowedSenders);
  const projects = stringList(input.projectRefs || [], { allowEmpty: true });
  if (purposes.some((purpose) => !PURPOSES.has(purpose))) fail('ADMIN_INPUT_INVALID');
  return transact(db, () => {
    for (const sender of senders) {
      const bound = db.prepare(`SELECT 1 FROM feishu_identity_bindings
        WHERE tenant_id=? AND channel_account_id=? AND open_id=? AND binding_status='ACTIVE'`)
        .get(input.tenantId, input.accountId, sender);
      if (!bound) fail('ADMIN_INPUT_INVALID');
    }
    const at = new Date().toISOString();
    const existing = db.prepare(`SELECT group_scope_id FROM agent_group_scopes
      WHERE channel_account_id=? AND chat_id=? AND scope_status='ACTIVE'`).get(input.accountId, input.chatId);
    const groupScopeId = existing?.group_scope_id || randomUUID();
    if (existing) {
      db.prepare(`UPDATE agent_group_scopes SET tenant_id=?, allowed_purposes_json=?,
        allowed_senders_json=?, project_refs_json=?, require_mention=1, updated_at=?
        WHERE group_scope_id=?`).run(input.tenantId, JSON.stringify(purposes), JSON.stringify(senders), JSON.stringify(projects), at, groupScopeId);
    } else {
      db.prepare(`INSERT INTO agent_group_scopes
        (group_scope_id, tenant_id, channel_account_id, chat_id, scope_status,
         allowed_purposes_json, allowed_senders_json, project_refs_json, require_mention, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 1, ?, ?)`).run(
        groupScopeId, input.tenantId, input.accountId, input.chatId,
        JSON.stringify(purposes), JSON.stringify(senders), JSON.stringify(projects), at, at,
      );
    }
    recordEvent(db, admin, {
      action: 'GRANT_GROUP', kind: 'GROUP', target: `${input.accountId}\0${input.chatId}`,
      result: existing ? 'UPDATED' : 'APPLIED',
      detail: { purpose_count: purposes.length, sender_count: senders.length, project_count: projects.length },
    }, at);
    return { groupScopeId, status: 'ACTIVE', updated: !!existing };
  });
}

export function revokeGroupScope(db, input, options) {
  const admin = adminContext(options);
  if (![input.accountId, input.chatId].every(text)) fail('ADMIN_INPUT_INVALID');
  return transact(db, () => {
    const at = new Date().toISOString();
    const row = db.prepare(`SELECT group_scope_id FROM agent_group_scopes
      WHERE channel_account_id=? AND chat_id=? AND scope_status='ACTIVE'`).get(input.accountId, input.chatId);
    if (!row) fail('ADMIN_TARGET_NOT_FOUND');
    db.prepare(`UPDATE agent_group_scopes SET scope_status='REVOKED', revoked_at=?, updated_at=?
      WHERE group_scope_id=?`).run(at, at, row.group_scope_id);
    recordEvent(db, admin, { action: 'REVOKE_GROUP', kind: 'GROUP', target: `${input.accountId}\0${input.chatId}`, result: 'UPDATED' }, at);
    return { groupScopeId: row.group_scope_id, status: 'REVOKED' };
  });
}
