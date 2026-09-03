import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { bindIdentity, grantGroupScope } from '../src/agent-gateway/admin.js';
import { authorizePrincipal, hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import { assertSafeAgentProjection } from '../src/agent-gateway/projection.js';

const APP_HASH = hashFeishuAppKey('cli_brainx');
const ADMIN = { actor: 'admin-york', allowedAdmins: ['admin-york'], auditKey: 'isolation-audit-key-that-is-over-32-bytes' };

function setup() {
  const db = openDb(':memory:');
  for (const [openId, consultantId] of [['ou_mia', 'mia'], ['ou_felix', 'felix']]) {
    bindIdentity(db, { tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH, openId, consultantId }, ADMIN);
  }
  grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_a', allowedPurposes: ['job_review'],
    allowedSenders: ['ou_mia'], projectRefs: ['job-shared'],
  }, ADMIN);
  grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_b', allowedPurposes: ['job_review'],
    allowedSenders: ['ou_felix'], projectRefs: ['job-b'],
  }, ADMIN);
  return db;
}

const principalPayload = (sender, overrides = {}) => ({
  channel: 'feishu', account_id: 'brainx-prod', requester_sender_id: sender,
  chat_type: 'p2p', chat_id: sender, purpose: 'job_review', tool_name: 'brainx_job_assessment',
  ...overrides,
});

test('相同工具请求按 App sender 分别解析本人，不存在默认 Mia', () => {
  const db = setup();
  const mia = authorizePrincipal(db, principalPayload('ou_mia'), { feishuAppKeyHash: APP_HASH, projectRef: 'job-shared' });
  const felix = authorizePrincipal(db, principalPayload('ou_felix'), { feishuAppKeyHash: APP_HASH, projectRef: 'job-shared' });
  assert.equal(mia.consultantId, 'mia');
  assert.equal(felix.consultantId, 'felix');
  assert.throws(() => authorizePrincipal(db, principalPayload('ou_unknown'), { feishuAppKeyHash: APP_HASH }), /UNBOUND_IDENTITY/);
});

test('群 sender 不能跨群，群 scope 不能跨项目', () => {
  const db = setup();
  const groupA = principalPayload('ou_mia', { chat_type: 'group', chat_id: 'oc_a' });
  assert.equal(authorizePrincipal(db, groupA, { feishuAppKeyHash: APP_HASH, projectRef: 'job-shared' }).consultantId, 'mia');
  assert.throws(() => authorizePrincipal(db, { ...groupA, requester_sender_id: 'ou_felix' }, {
    feishuAppKeyHash: APP_HASH, projectRef: 'job-shared',
  }), /NOT_FOUND_OR_FORBIDDEN/);
  assert.throws(() => authorizePrincipal(db, groupA, { feishuAppKeyHash: APP_HASH, projectRef: 'job-b' }), /NOT_FOUND_OR_FORBIDDEN/);
});

test('工具参数不能注入身份或改写范围', async () => {
  const registry = createToolRegistry({ handlers: { brainx_job_assessment: async () => ({ data: {} }) } });
  const context = { principal: { consultantId: 'mia', purpose: 'job_review' } };
  await assert.rejects(() => registry.execute('brainx_job_assessment', {
    job_id: 'job-shared', consultant_id: 'felix',
  }, context), /INVALID_ARGUMENT/);
  await assert.rejects(() => registry.execute('brainx_job_assessment', {
    job_id: 'job-shared', sql: 'SELECT * FROM talent',
  }, context), /INVALID_ARGUMENT/);
});

test('私聊和群聊投影均拒联系方式/原文，群聊额外拒私人信息', () => {
  const p2p = { chatType: 'p2p' };
  const group = { chatType: 'group' };
  assert.deepEqual(assertSafeAgentProjection({ data: { candidate_ref: 'cand-a', summary: '8 年招聘经验' } }, p2p),
    { data: { candidate_ref: 'cand-a', summary: '8 年招聘经验' } });
  for (const unsafe of [
    { data: { phone: '13800138000' } }, { data: { summary: '联系 a@example.com' } },
    { data: { resume_raw: '完整简历' } },
  ]) assert.throws(() => assertSafeAgentProjection(unsafe, p2p), /PROJECTION_REJECTED/);
  for (const unsafe of [
    { data: { private_note: '顾问私评' } }, { data: { candidate_salary: '50k' } },
  ]) assert.throws(() => assertSafeAgentProjection(unsafe, group), /PROJECTION_REJECTED/);
});

test('只有候选联系 purpose 的私聊投影可以返回联系方式', () => {
  const principal = { chatType: 'p2p', purpose: 'candidate_contact' };
  assert.doesNotThrow(() => assertSafeAgentProjection({ data: {
    contact: { phone: '13800138000', email: 'candidate@example.com' },
  } }, principal));
  assert.throws(() => assertSafeAgentProjection({ data: {
    note: '请联系 13800138000',
  } }, principal), /PROJECTION_REJECTED/);
  assert.throws(() => assertSafeAgentProjection({ data: {
    contact: { phone: '13800138000' },
  } }, { chatType: 'group', purpose: 'candidate_contact' }), /PROJECTION_REJECTED/);
});
