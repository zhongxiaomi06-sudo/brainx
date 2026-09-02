import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  authorizePrincipal,
  hashFeishuAppKey,
} from '../src/agent-gateway/authorization.js';

const NOW = '2026-09-03T08:00:00.000Z';
const APP_HASH = hashFeishuAppKey('cli_a_brainx');

function seedBinding(db, overrides = {}) {
  const row = {
    binding_id: 'binding-mia', tenant_id: 'tenant-a', channel_account_id: 'brainx-prod',
    feishu_app_key_hash: APP_HASH, open_id: 'ou_mia', consultant_id: 'mia',
    binding_status: 'ACTIVE', ...overrides,
  };
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id, tenant_id, channel_account_id, feishu_app_key_hash, open_id,
     consultant_id, binding_status, verified_at, verified_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', ?, ?)`).run(
    row.binding_id, row.tenant_id, row.channel_account_id, row.feishu_app_key_hash,
    row.open_id, row.consultant_id, row.binding_status, NOW, NOW, NOW,
  );
}

function seedGroup(db, overrides = {}) {
  const row = {
    group_scope_id: 'scope-a', tenant_id: 'tenant-a', channel_account_id: 'brainx-prod',
    chat_id: 'oc_project_a', scope_status: 'ACTIVE',
    allowed_purposes_json: JSON.stringify(['candidate_review']),
    allowed_senders_json: JSON.stringify(['ou_mia']),
    project_refs_json: JSON.stringify(['job-a']),
    ...overrides,
  };
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id, tenant_id, channel_account_id, chat_id, scope_status,
     allowed_purposes_json, allowed_senders_json, project_refs_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.group_scope_id, row.tenant_id, row.channel_account_id, row.chat_id,
    row.scope_status, row.allowed_purposes_json, row.allowed_senders_json,
    row.project_refs_json, NOW, NOW,
  );
}

function payload(overrides = {}) {
  return {
    channel: 'feishu', account_id: 'brainx-prod', requester_sender_id: 'ou_mia',
    chat_type: 'p2p', chat_id: 'ou_mia', purpose: 'daily_brief',
    tool_name: 'brainx_daily_brief', ...overrides,
  };
}

test('私聊身份按 App+open_id 精确解析，不能由参数指定 consultant', () => {
  const db = openDb(':memory:');
  seedBinding(db);
  const principal = authorizePrincipal(db, payload(), { feishuAppKeyHash: APP_HASH });
  assert.deepEqual(principal, {
    tenantId: 'tenant-a', consultantId: 'mia', accountId: 'brainx-prod',
    senderId: 'ou_mia', chatType: 'p2p', chatId: 'ou_mia', purpose: 'daily_brief',
  });
});

test('跨 App、撤销身份、停用顾问和伪造私聊目标均失败关闭', () => {
  for (const scenario of ['wrong_app', 'revoked', 'inactive', 'fake_chat']) {
    const db = openDb(':memory:');
    seedBinding(db, scenario === 'revoked' ? { binding_status: 'REVOKED' } : {});
    if (scenario === 'inactive') db.prepare("UPDATE consultants SET active=0 WHERE consultant_id='mia'").run();
    const options = { feishuAppKeyHash: scenario === 'wrong_app' ? hashFeishuAppKey('cli_b') : APP_HASH };
    const candidate = payload(scenario === 'fake_chat' ? { chat_id: 'ou_other' } : {});
    assert.throws(() => authorizePrincipal(db, candidate, options), /UNBOUND_IDENTITY|NOT_FOUND_OR_FORBIDDEN/);
  }
});

test('工具与 purpose 必须采用服务端固定映射', () => {
  const db = openDb(':memory:');
  seedBinding(db);
  assert.throws(() => authorizePrincipal(db, payload({ purpose: 'candidate_review' }), {
    feishuAppKeyHash: APP_HASH,
  }), /NOT_FOUND_OR_FORBIDDEN/);
  assert.throws(() => authorizePrincipal(db, payload({ tool_name: 'query_sql' }), {
    feishuAppKeyHash: APP_HASH,
  }), /NOT_FOUND_OR_FORBIDDEN/);
});

test('群聊同时校验白名单群、sender、purpose 与项目范围', () => {
  const db = openDb(':memory:');
  seedBinding(db);
  seedGroup(db);
  const group = payload({
    chat_type: 'group', chat_id: 'oc_project_a', purpose: 'candidate_review',
    tool_name: 'brainx_candidate_shortlist',
  });
  const allowed = authorizePrincipal(db, group, { feishuAppKeyHash: APP_HASH, projectRef: 'job-a' });
  assert.equal(allowed.consultantId, 'mia');
  for (const changed of [
    { chat_id: 'oc_unknown' }, { requester_sender_id: 'ou_other' }, { purpose: 'interview_prep' },
  ]) {
    assert.throws(() => authorizePrincipal(db, { ...group, ...changed }, {
      feishuAppKeyHash: APP_HASH, projectRef: 'job-a',
    }), /NOT_FOUND_OR_FORBIDDEN|UNBOUND_IDENTITY/);
  }
  assert.throws(() => authorizePrincipal(db, group, {
    feishuAppKeyHash: APP_HASH, projectRef: 'job-b',
  }), /NOT_FOUND_OR_FORBIDDEN/);
});

test('损坏的群 scope JSON 和缺失 App 配置不能降级放行', () => {
  const db = openDb(':memory:');
  seedBinding(db);
  seedGroup(db, { allowed_senders_json: 'not-json' });
  const group = payload({
    chat_type: 'group', chat_id: 'oc_project_a', purpose: 'candidate_review',
    tool_name: 'brainx_candidate_shortlist',
  });
  assert.throws(() => authorizePrincipal(db, group, {
    feishuAppKeyHash: APP_HASH, projectRef: 'job-a',
  }), /NOT_FOUND_OR_FORBIDDEN/);
  assert.throws(() => authorizePrincipal(db, payload(), {}), /UNBOUND_IDENTITY/);
});
