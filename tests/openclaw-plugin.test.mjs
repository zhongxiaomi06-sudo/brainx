import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { verifyPrincipalAssertion } from '../src/agent-gateway/assertion.js';
import { createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import {
  BRAINX_OPENCLAW_TOOLS,
  createBrainxToolFactory,
  resolveTrustedPrincipal,
} from '../plugins/brainx-openclaw/runtime.js';
import { createBraintexPromptContext } from '../plugins/brainx-openclaw/prompt.js';
import { createCandidateReportCommand } from '../plugins/brainx-openclaw/onboarding.js';

const root = new URL('../', import.meta.url);
const fixture = JSON.parse(await readFile(new URL('tests/fixtures/openclaw-production/plugin-contract.json', root)));
const manifest = JSON.parse(await readFile(new URL('plugins/brainx-openclaw/openclaw.plugin.json', root)));
const pkg = JSON.parse(await readFile(new URL('plugins/brainx-openclaw/package.json', root)));
const entrySource = await readFile(new URL('plugins/brainx-openclaw/index.js', root), 'utf8');
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
  assert.deepEqual(manifest.activation, { onStartup: true });
  assert.match(entrySource, /api\.on\('message_received'/);
  assert.match(entrySource, /api\.on\('reply_payload_sending'/);
  assert.match(entrySource, /api\.on\('before_prompt_build'/);
  assert.doesNotMatch(entrySource, /registerHook\('reply_payload_sending'/);
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(manifest.contracts.commands, ['brainx', 'report']);
  assert.deepEqual(manifest.contracts.tools, fixture.allowed_tools);
  assert.deepEqual(BRAINX_OPENCLAW_TOOLS.map(({ name }) => name), fixture.allowed_tools);
  assert.equal(new Set(manifest.contracts.tools).size, 25);
  assert.ok(!manifest.contracts.tools.includes('brainx_send_candidate_resume'));
  for (const tool of BRAINX_OPENCLAW_TOOLS) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal('url' in tool.parameters.properties, false);
    assert.equal('sender' in tool.parameters.properties, false);
  }
});

test('npm package includes every local module imported by a shipped JavaScript file', async () => {
  const shipped = new Set(pkg.files);
  for (const file of pkg.files.filter((name) => name.endsWith('.js'))) {
    const source = await readFile(new URL(`plugins/brainx-openclaw/${file}`, root), 'utf8');
    for (const match of source.matchAll(/from ['"]\.\/([^'"]+)['"]/g)) {
      assert.ok(shipped.has(match[1]), `${file} imports ${match[1]} but package.json files omits it`);
    }
  }
});

test('BrainTex prompt routes natural-language job recommendations to authorized data', () => {
  const prompt = createBraintexPromptContext({ messageProvider: 'feishu' });
  assert.match(prompt, /推荐三个/);
  assert.match(prompt, /brainx_daily_brief/);
  assert.match(prompt, /不得凭常识编造职位方向/);
  assert.match(prompt, /固定格式/);
  assert.match(prompt, /N\. 公司｜职位｜job\.project_id/);
  assert.match(prompt, /不得省略、改写或隐藏职位 ID/);
  assert.match(prompt, /即使用户只要求简短列表/);
  assert.match(prompt, /OpenMai 找人.*SuperMai 找人/s);
  assert.match(prompt, /找人条件：/);
  assert.match(prompt, /只是在保存下一次搜索的可选条件/);
  assert.match(prompt, /不得在这条消息上调用任何找人工具/);
  assert.match(prompt, /否则会与随后按钮形成重复付费任务/);
  assert.match(prompt, /第一次调用传 continue_search=true/);
  assert.match(prompt, /后续轮询必须改为 continue_search=false/);
  assert.match(prompt, /按钮本身就是.*明确选择/);
  assert.match(prompt, /KEEP_FOR_REVIEW/);
  assert.match(prompt, /focused_candidates/);
  assert.match(prompt, /\/report.*brainx_candidate_report/s);
  assert.match(prompt, /为这个人建群.*CREATE_DECISION_GROUP/s);
  assert.match(prompt, /消息本身就是.*明确确认/);
  // 项目搜索由 worker 自动投递；自由搜索仍保留轮询纪律。
  assert.match(prompt, /不得因为表格列多就删掉链接/);
  assert.match(prompt, /把原始链接补回去/);
  assert.match(prompt, /正在找人/);
  assert.match(prompt, /完成后候选人会自动发到本群/);
  assert.match(prompt, /不得原地连续轮询/);
  // specs/011 修订：接单 SOP——用户不碰参数，先岗位理解再确认，两参调用
  assert.match(prompt, /接单流程（用户全程不提供任何参数/);
  assert.match(prompt, /先定位唯一职位[\s\S]*?brainx_daily_brief/);
  assert.match(prompt, /岗位理解[\s\S]*?确认接【公司·职位】这个岗位吗/);
  assert.match(prompt, /立即调用 brainx_accept_job，不要再问第二遍/);
  assert.match(prompt, /参数只有 \{ job_id, confirm: true \}/);
  assert.match(prompt, /职位无法唯一定位或用户未确认时，不得调用接单工具/);
  assert.equal(createBraintexPromptContext({ messageProvider: 'telegram' }), undefined);
});

test('/report 只让已授权飞书发送人继续进入报告编排', async () => {
  const command = createCandidateReportCommand();
  assert.equal(command.name, 'report');
  assert.equal((await command.handler({ channel: 'feishu', isAuthorizedSender: true })).continueAgent, true);
  assert.equal((await command.handler({ channel: 'feishu', isAuthorizedSender: false })).isError, true);
});

test('项目群双找人入口支持可选条件且不接受身份或路由注入', () => {
  const openmai = BRAINX_OPENCLAW_TOOLS.find(({ name }) => name === 'brainx_openmai_search');
  const supermai = BRAINX_OPENCLAW_TOOLS.find(({ name }) => name === 'brainx_supermai_scout');
  assert.deepEqual(openmai.parameters.required, ['job_id']);
  assert.equal(openmai.parameters.properties.criteria.maxLength, 2000);
  assert.equal(openmai.parameters.properties.continue_search.type, 'boolean');
  assert.deepEqual(supermai.parameters.required, []);
  assert.deepEqual(Object.keys(supermai.parameters.properties), ['job_id', 'criteria', 'continue_search']);
  assert.equal(supermai.parameters.additionalProperties, false);
  const gateway = createToolRegistry();
  assert.deepEqual(gateway.schema('brainx_openmai_search'), openmai.parameters,
    '插件参数必须与 BrainX 网关白名单一致');
  assert.deepEqual(gateway.schema('brainx_supermai_scout'), supermai.parameters,
    '插件参数必须与 BrainX 网关白名单一致');
  const workflow = BRAINX_OPENCLAW_TOOLS.find(({ name }) => name === 'brainx_candidate_workflow');
  assert.ok(workflow.parameters.properties.action.enum.includes('KEEP_FOR_REVIEW'));
  assert.ok(workflow.parameters.properties.action.enum.includes('REMOVE_FROM_REVIEW'));
  assert.ok(workflow.parameters.properties.action.enum.includes('CREATE_DECISION_GROUP'));
  assert.ok(workflow.parameters.properties.action.enum.includes('SEND_TALENT_CARD'));
  assert.deepEqual(gateway.schema('brainx_candidate_workflow'), workflow.parameters,
    '候选保留参数必须与 BrainX 网关白名单一致');
  const report = BRAINX_OPENCLAW_TOOLS.find(({ name }) => name === 'brainx_candidate_report');
  assert.deepEqual(gateway.schema('brainx_candidate_report'), report.parameters,
    '报告参数必须与 BrainX 网关白名单一致');
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
    plugin_version: '1.3.18', openclaw_version: '2026.7.1-2', model_ref: 'openai/gpt-5',
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
