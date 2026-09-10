import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import { createPrincipalAssertion } from '../src/agent-gateway/assertion.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import { createAgentGatewayServer } from '../src/agent-gateway/server.js';

const TOKEN = 'gateway-test-token-that-is-over-32-bytes';
const SECRET = 'assertion-test-secret-that-is-over-32-bytes';
const AUDIT_KEY = 'audit-test-key-that-is-over-32-bytes';
const APP_HASH = hashFeishuAppKey('cli_brainx');
let server;
let base;

function seed(db) {
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id, tenant_id, channel_account_id, feishu_app_key_hash, open_id,
     consultant_id, binding_status, verified_at, verified_by, created_at, updated_at)
    VALUES ('binding-mia','tenant-a','brainx-prod',?,'ou_mia','mia','ACTIVE',?,'test',?,?)`)
    .run(APP_HASH, at, at, at);
}

function signedBody(toolName = 'brainx_me_context', argumentsValue = {}) {
  const requestId = randomUUID();
  const { assertion } = createPrincipalAssertion({
    request_id: requestId, channel: 'feishu', account_id: 'brainx-prod',
    requester_sender_id: 'ou_mia', chat_type: 'p2p', chat_id: 'ou_mia', thread_id: null,
    purpose: 'self_context', tool_name: toolName, arguments: argumentsValue,
  }, { secret: SECRET });
  return {
    schema_version: 'agent_tool_request.v1', request_id: requestId,
    principal_assertion: assertion, arguments: argumentsValue,
    client: { plugin_version: '1.0.0', openclaw_version: '2026.7.1-2' },
  };
}

before(async () => {
  const db = openDb(':memory:');
  seed(db);
  const registry = createToolRegistry({
    handlers: { brainx_me_context: async (_args, context) => ({
      data: { consultant_ref: 'self', consultant_id_used: context.principal.consultantId },
      facts: [], unknowns: [],
    }) },
  });
  server = createAgentGatewayServer({
    db, registry, gatewayToken: TOKEN, assertionSecret: SECRET, auditKey: AUDIT_KEY,
    feishuAppKeyHashes: { 'brainx-prod': APP_HASH }, rateLimit: 20,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.closeAllConnections?.();
  server?.close();
});

test('健康检查返回状态、授权就绪度、版本与固定 25 个工具', async () => {
  const response = await fetch(`${base}/internal/v1/agent/health`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'ready');
  assert.deepEqual(data.authorization, {
    status: 'ready', configured_accounts: 1, bound_identities: 1,
  });
  assert.equal(data.tools.length, 25);
  assert.equal(data.tool_catalog_version, 'agent-tools.v2');
  assert.doesNotMatch(JSON.stringify(data), /token|secret|open_id|consultant/i);
});

test('缺飞书 App 映射时拒绝启动，零有效身份时健康检查不再假报 ready', async () => {
  const db = openDb(':memory:');
  const registry = createToolRegistry({ handlers: {} });
  const baseConfig = {
    db, registry, gatewayToken: TOKEN, assertionSecret: SECRET, auditKey: AUDIT_KEY,
  };
  assert.throws(() => createAgentGatewayServer({ ...baseConfig, feishuAppKeyHashes: {} }),
    /GATEWAY_CONFIG_INVALID/);
  const emptyServer = createAgentGatewayServer({
    ...baseConfig, feishuAppKeyHashes: { 'brainx-prod': APP_HASH },
  });
  await new Promise((resolve) => emptyServer.listen(0, '127.0.0.1', resolve));
  try {
    const address = emptyServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/v1/agent/health`);
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.status, 'not_ready');
    assert.deepEqual(data.authorization, {
      status: 'not_ready', configured_accounts: 1, bound_identities: 0,
    });
  } finally {
    await new Promise((resolve) => emptyServer.close(resolve));
    db.close();
  }
});

test('工具端点只接受 POST、Bearer 和 JSON 且限制 64 KiB', async () => {
  const get = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`);
  assert.equal(get.status, 405);
  const unauthenticated = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unauthenticated.status, 401);
  const wrongType = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'text/plain' }, body: '{}',
  });
  assert.equal(wrongType.status, 415);
  const oversized = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(66 * 1024) }),
  });
  assert.equal(oversized.status, 413);
});

test('未知工具与非法请求契约均失败关闭', async () => {
  const unknown = await fetch(`${base}/internal/v1/agent/tools/query_sql`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unknown.status, 404);
  const invalid = signedBody();
  invalid.extra = 'not-allowed';
  const response = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(invalid),
  });
  assert.equal(response.status, 422);
  const injected = signedBody('brainx_me_context', { consultant_id: 'felix' });
  const injectionResponse = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(injected),
  });
  assert.equal(injectionResponse.status, 422);
});

test('合法声明调用固定 handler，篡改与 nonce 重放被拒绝', async () => {
  const body = signedBody();
  const call = () => fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const first = await call();
  assert.equal(first.status, 200);
  const output = await first.json();
  assert.equal(output.data.consultant_id_used, 'mia');
  assert.equal(output.data_scope.consultant_ref, 'self');
  const replay = await call();
  assert.equal(replay.status, 409);

  const tampered = signedBody();
  tampered.arguments = { unexpected: true };
  const bad = await fetch(`${base}/internal/v1/agent/tools/brainx_me_context`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(tampered),
  });
  assert.equal(bad.status, 401);
});
