import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import {
  bindIdentity,
  revokeIdentity,
  grantGroupScope,
  revokeGroupScope,
} from '../src/agent-gateway/admin.js';

const APP_HASH = hashFeishuAppKey('cli_brainx');
const ADMIN = { actor: 'admin-york', allowedAdmins: ['admin-york'], auditKey: 'admin-audit-key-that-is-at-least-32-bytes' };

function identity(overrides = {}) {
  return {
    tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
    openId: 'ou_mia', consultantId: 'mia', ...overrides,
  };
}

test('只有显式 allowlist 管理员能绑定，且同 App+open_id 不可冲突', () => {
  const db = openDb(':memory:');
  assert.throws(() => bindIdentity(db, identity(), { ...ADMIN, actor: 'unknown' }), /ADMIN_FORBIDDEN/);
  const first = bindIdentity(db, identity(), ADMIN);
  assert.equal(first.status, 'ACTIVE');
  assert.equal(bindIdentity(db, identity(), ADMIN).bindingId, first.bindingId);
  assert.throws(() => bindIdentity(db, identity({ consultantId: 'felix' }), ADMIN), /IDENTITY_CONFLICT/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feishu_identity_bindings WHERE binding_status='ACTIVE'").get().n, 1);
});

test('撤销身份立即失效且重复撤销不伪装成功', () => {
  const db = openDb(':memory:');
  bindIdentity(db, identity(), ADMIN);
  assert.equal(revokeIdentity(db, { accountId: 'brainx-prod', openId: 'ou_mia' }, ADMIN).status, 'REVOKED');
  assert.throws(() => revokeIdentity(db, { accountId: 'brainx-prod', openId: 'ou_mia' }, ADMIN), /ADMIN_TARGET_NOT_FOUND/);
});

test('群 scope 只接受本 App 已绑定 sender、固定 purpose，并可撤销', () => {
  const db = openDb(':memory:');
  bindIdentity(db, identity(), ADMIN);
  const scope = grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_project_a',
    allowedPurposes: ['candidate_review'], allowedSenders: ['ou_mia'], projectRefs: ['job-a'],
  }, ADMIN);
  assert.equal(scope.status, 'ACTIVE');
  assert.equal(grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_project_a',
    allowedPurposes: ['candidate_review'], allowedSenders: ['ou_mia'], projectRefs: ['job-a'],
  }, ADMIN).groupScopeId, scope.groupScopeId);
  assert.throws(() => grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_bad',
    allowedPurposes: ['arbitrary'], allowedSenders: ['ou_mia'], projectRefs: [],
  }, ADMIN), /ADMIN_INPUT_INVALID/);
  assert.throws(() => grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_bad',
    allowedPurposes: ['candidate_review'], allowedSenders: ['ou_other'], projectRefs: [],
  }, ADMIN), /ADMIN_INPUT_INVALID/);
  assert.equal(revokeGroupScope(db, { accountId: 'brainx-prod', chatId: 'oc_project_a' }, ADMIN).status, 'REVOKED');
});

test('所有权限变更都有脱敏管理员审计，不保存 open_id/chat_id/actor 明文', () => {
  const db = openDb(':memory:');
  bindIdentity(db, identity(), ADMIN);
  grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_project_a',
    allowedPurposes: ['candidate_review'], allowedSenders: ['ou_mia'], projectRefs: ['job-a'],
  }, ADMIN);
  const rows = db.prepare('SELECT * FROM agent_admin_events').all();
  assert.equal(rows.length, 2);
  assert.doesNotMatch(JSON.stringify(rows), /admin-york|ou_mia|oc_project_a/);
  const groupEvent = rows.find((row) => row.action === 'GRANT_GROUP');
  assert.deepEqual(JSON.parse(groupEvent.detail_json), { purpose_count: 1, sender_count: 1, project_count: 1 });
});
