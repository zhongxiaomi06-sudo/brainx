import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { verifyPrincipalAssertion } from '../src/agent-gateway/assertion.js';
import {
  BRAINX_OPENCLAW_TOOLS,
  createBrainxToolFactory,
  resolveTrustedPrincipal,
} from '../plugins/brainx-openclaw/runtime.js';

const root = new URL('../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('tests/fixtures/openclaw-production/plugin-contract.json', root)));
const manifest = JSON.parse(await readFile(new URL('plugins/brainx-openclaw/openclaw.plugin.json', root)));
const pkg = JSON.parse(await readFile(new URL('plugins/brainx-openclaw/package.json', root)));
const secret = 'p'.repeat(32);

const p2pContext = {
  requesterSenderId: 'ou_mia',
  agentAccountId: 'mia',
  messageChannel: 'feishu',
  deliveryContext: {
    channel: 'feishu',
    to: 'user:ou_mia',
    accountId: 'mia',
    threadId: 'om_thread',
  },
  activeModel: { modelRef: 'openai/gpt-5' },
};

test('plugin package and manifest declare exactly the approved tools', () => {
  assert.equal(pkg.peerDependencies.openclaw, fixture.plugin_api_min);
  assert.deepEqual(pkg.openclaw.extensions, ['./index.js']);
  assert.equal(manifest.id, 'brainx-openclaw');
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.contracts.commands, ['brainx']);
  assert.deepEqual(manifest.contracts.tools, fixture.allowed_tools);
  assert.deepEqual(BRAINX_OPENCLAW_TOOLS.map(({ name }) => name), fixture.allowed_tools);
  assert.equal(new Set(manifest.contracts.tools).size, 10);
  for (const tool of BRAINX_OPENCLAW_TOOLS) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal('url' in tool.parameters.properties, false);
    assert.equal('sender' in tool.parameters.properties, false);
  }
});

test('trusted principal rejects missing, inconsistent, non-Feishu, and forged private contexts', () => {
  assert.throws(() => resolveTrustedPrincipal({}), /TRUSTED_CONTEXT_MISSING/);
  assert.throws(() => resolveTrustedPrincipal({ ...p2pContext, requesterSenderId: '' }), /TRUSTED_CONTEXT_MISSING/);
  assert.throws(() => resolveTrustedPrincipal({ ...p2pContext, messageChannel: 'telegram' }), /TRUSTED_CONTEXT_INVALID/);
  assert.throws(() => resolveTrustedPrincipal({
    ...p2pContext,
    deliveryContext: { ...p2pContext.deliveryContext, accountId: 'other' },
  }), /TRUSTED_CONTEXT_INVALID/);
  assert.throws(() => resolveTrustedPrincipal({
    ...p2pContext,
    deliveryContext: { ...p2pContext.deliveryContext, to: 'user:ou_other' },
  }), /TRUSTED_CONTEXT_INVALID/);
});

test('trusted principal derives p2p and group identity only from runtime context', () => {
  assert.deepEqual(resolveTrustedPrincipal(p2pContext), {
    channel: 'feishu', account_id: 'mia', requester_sender_id: 'ou_mia',
    chat_type: 'p2p', chat_id: 'ou_mia', thread_id: 'om_thread',
    model_ref: 'openai/gpt-5',
  });
  assert.deepEqual(resolveTrustedPrincipal({
    ...p2pContext,
    deliveryContext: { ...p2pContext.deliveryContext, to: 'chat:oc_project', threadId: undefined },
  }), {
    channel: 'feishu', account_id: 'mia', requester_sender_id: 'ou_mia',
    chat_type: 'group', chat_id: 'oc_project', thread_id: null,
    model_ref: 'openai/gpt-5',
  });
});

test('tool request is fixed to loopback and produces a BrainX-verifiable assertion', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      schema_version: 'agent_tool_response.v1', ok: true, data: { facts: [] },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const factory = createBrainxToolFactory(
    BRAINX_OPENCLAW_TOOLS.find(({ name }) => name === 'brainx_job_assessment'),
    { fetchImpl, gatewayToken: 'token-value', assertionSecret: secret, now: () => new Date('2026-09-03T00:00:00.000Z') },
  );
  const result = await factory(p2pContext).execute('tool-call', { job_id: 'job-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:3102/internal/v1/agent/tools/brainx_job_assessment');
  assert.equal(calls[0].options.headers.authorization, 'Bearer token-value');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.schema_version, 'agent_tool_request.v1');
  assert.deepEqual(body.client, {
    plugin_version: '1.0.0', openclaw_version: '2026.7.1-2', model_ref: 'openai/gpt-5',
  });
  const payload = verifyPrincipalAssertion(body.principal_assertion, {
    secret,
    now: new Date('2026-09-03T00:00:01.000Z'),
    requestId: body.request_id,
    toolName: 'brainx_job_assessment',
    arguments: body.arguments,
  });
  assert.equal(payload.requester_sender_id, 'ou_mia');
  assert.equal(payload.account_id, 'mia');
  assert.equal(payload.purpose, 'job_review');
  assert.deepEqual(result.details, { schema_version: 'agent_tool_response.v1', ok: true, data: { facts: [] } });
});

test('tool fails closed before network when secrets or trusted context are absent', async () => {
  let called = false;
  const factory = createBrainxToolFactory(BRAINX_OPENCLAW_TOOLS[0], {
    fetchImpl: async () => { called = true; },
    gatewayToken: '',
    assertionSecret: secret,
  });
  await assert.rejects(() => factory(p2pContext).execute('call', {}), /PLUGIN_NOT_CONFIGURED/);
  await assert.rejects(() => factory({}).execute('call', {}), /TRUSTED_CONTEXT_MISSING/);
  assert.equal(called, false);
});
