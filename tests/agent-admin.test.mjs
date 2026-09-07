import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import {
  bindIdentity,
  revokeIdentity,
  grantGroupScope,
  revokeGroupScope,
  bindRosterIdentities,
  getRecruitingReadiness,
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

test('就绪报告逐层定位白名单、Gateway 身份和 TTC 缺项且不泄露 open_id', () => {
  const db = openDb(':memory:');
  const miaOpenId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='mia'").get().open_id;
  const report = getRecruitingReadiness(db, {
    accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH, allowedOpenIds: [miaOpenId],
  }, ADMIN);
  const mia = report.items.find((item) => item.consultant_id === 'mia');
  assert.equal(mia.roster_identity, true);
  assert.equal(mia.openclaw_allowlisted, true);
  assert.equal(mia.gateway_identity_bound, false);
  assert.ok(mia.blockers.includes('GATEWAY_IDENTITY_MISSING'));
  assert.ok(mia.blockers.includes('TTC_CREDENTIALS_REQUIRED'));
  assert.doesNotMatch(JSON.stringify(report), /ou_|jwt|app_key/i);
});

test('管理员可显式确认后从已核验花名册原子批量绑定，重复执行幂等', () => {
  const db = openDb(':memory:');
  assert.throws(() => bindRosterIdentities(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
    consultantIds: ['mia'], confirm: false,
  }, ADMIN), /ADMIN_INPUT_INVALID/);
  const first = bindRosterIdentities(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
    consultantIds: ['mia', 'felix'], confirm: true,
  }, ADMIN);
  assert.deepEqual(first, { status: 'ACTIVE', selected: 2, created: 2, already: 0 });
  const second = bindRosterIdentities(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
    consultantIds: ['mia', 'felix'], confirm: true,
  }, ADMIN);
  assert.deepEqual(second, { status: 'ACTIVE', selected: 2, created: 0, already: 2 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feishu_identity_bindings WHERE binding_status='ACTIVE'").get().n, 2);
});

test('花名册批量绑定遇到身份冲突时整批回滚', () => {
  const db = openDb(':memory:');
  const felixOpenId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  bindIdentity(db, identity({ openId: felixOpenId, consultantId: 'mia' }), ADMIN);
  assert.throws(() => bindRosterIdentities(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
    consultantIds: ['mia', 'felix'], confirm: true,
  }, ADMIN), /IDENTITY_CONFLICT/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM feishu_identity_bindings WHERE binding_status='ACTIVE'").get().n, 1);
});
