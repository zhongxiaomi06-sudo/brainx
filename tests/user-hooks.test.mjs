import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createUserHookHandler, loadUserHooksConfig } from '../plugins/brainx-openclaw/user-hooks.js';

const root = new URL('../', import.meta.url);
const bundledConfig = JSON.parse(await readFile(new URL('plugins/brainx-openclaw/user-hooks.json', root)));
const hookById = (id) => bundledConfig.hooks.find((hook) => hook.id === id);

const LINDA_HOOK = hookById('linda-private-launch');
const WENDY_HOOK = hookById('wendy-private-group');
const YANG_HOOK = hookById('yang-offer-fixed-reply');
const LINDA_OPEN_ID = LINDA_HOOK.trigger.sender_open_id;
const WENDY_OPEN_ID = WENDY_HOOK.trigger.sender_open_id;
const YANG_CHAT_ID = YANG_HOOK.trigger.chat_id;

// 生产 sessionKey 格式：agent:feishu-mia-<hash>:feishu:mia:direct:<open_id>
const directSession = (openId) => `agent:feishu-mia-abc123:feishu:mia:direct:${openId}`;
const groupSession = (chatId) => `agent:feishu-mia-abc123:feishu:mia:group:${chatId}`;

function mockJsonFetch(responseBody, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responseBody), {
      status, headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

async function fireDirect({ hook, dependencies, text, senderId, sessionKey, context = {} }) {
  const sender = senderId ?? hook.trigger.sender_open_id;
  const session = sessionKey ?? directSession(sender);
  const handler = createUserHookHandler(hook, dependencies);
  handler.onMessageReceived({ sessionKey: session, content: text, fromId: sender }, context);
  return handler({ sessionKey: session, fromId: sender }, context);
}

// ---------- 配置加载 ----------

test('插件自带 user-hooks.json 含三条生产 hook 且全部合法', () => {
  const { hooks, errors } = loadUserHooksConfig({
    env: {},
    readFileImpl: () => JSON.stringify(bundledConfig),
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(hooks.map((hook) => hook.id), [
    'yang-offer-fixed-reply', 'wendy-private-group', 'linda-private-launch',
  ]);
  assert.deepEqual(hooks.map((hook) => hook.priority), [90, 95, 96]);
});

test('BRAINX_USER_HOOKS_FILE 可覆盖配置路径（开通新顾问=改配置）', () => {
  const custom = {
    version: 1,
    hooks: [{
      id: 'newbie-private-launch',
      priority: 96,
      trigger: { session: 'direct', sender_open_id: 'ou_new_consultant', keywords_all: ['接单'] },
      action: { type: 'accept_job', job_id: 'JA00001', job_label: 'JA00001 测试职位' },
    }],
  };
  const { hooks, errors } = loadUserHooksConfig({
    env: { BRAINX_USER_HOOKS_FILE: '/tmp/whatever.json' },
    readFileImpl: (path) => {
      assert.equal(path, '/tmp/whatever.json');
      return JSON.stringify(custom);
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(hooks[0].trigger.sender_open_id, 'ou_new_consultant');
});

test('配置文件缺失/损坏 → fail-open（空 hooks + errors），不拖垮插件', () => {
  const missing = loadUserHooksConfig({
    env: { BRAINX_USER_HOOKS_FILE: '/nonexistent.json' },
    readFileImpl: () => { throw new Error('ENOENT'); },
  });
  assert.deepEqual(missing.hooks, []);
  assert.equal(missing.errors.length, 1);
  const corrupt = loadUserHooksConfig({ env: {}, readFileImpl: () => '{not json' });
  assert.deepEqual(corrupt.hooks, []);
  const invalid = loadUserHooksConfig({
    env: {},
    readFileImpl: () => JSON.stringify({ hooks: [{ id: 'bad', trigger: { session: 'direct' }, action: { type: 'nope' } }] }),
  });
  assert.deepEqual(invalid.hooks, []);
  assert.match(invalid.errors[0], /keywords/);
});

// ---------- fixed_reply（原 yang-offer-reply 行为） ----------

function fireGroup({ hook, chatId, text, handler }) {
  const h = handler || createUserHookHandler(hook);
  h.onMessageReceived({ sessionKey: groupSession(chatId), content: text, metadata: { chatId } }, { conversationId: chatId });
  return h({ sessionKey: groupSession(chatId) }, {});
}

test('fixed_reply：目标群 + 关键词全含 → 固定文案拦截 LLM', async () => {
  const result = await fireGroup({
    hook: YANG_HOOK, chatId: YANG_CHAT_ID,
    text: '@braintex 的小机器人 总结一下，杨东旭目前的顾虑分别是什么，我分别应该如何解决，列出todo',
  });
  assert.equal(result.handled, true);
  assert.equal(result.reply.text, YANG_HOOK.action.text.join('\n'));
  assert.equal(result.reason, 'yang-offer-fixed-reply');
  assert.ok(result.reply.text.includes('P0｜紧急'));
  assert.ok(result.reply.text.includes('修复 HR 专业度 gap'));
  assert.ok(result.reply.text.includes('CEO 三面讲解期权方案'));
});

test('fixed_reply：非目标群 / 缺关键词 → 不拦截', async () => {
  assert.equal(await fireGroup({
    hook: YANG_HOOK, chatId: 'oc_other_group_0000000000000000000000', text: '总结一下杨东旭的顾虑',
  }), undefined);
  assert.equal(await fireGroup({ hook: YANG_HOOK, chatId: YANG_CHAT_ID, text: '杨东旭意愿度多少' }), undefined);
});

test('fixed_reply：关键词变体（"总结一下顾虑"）→ 仍拦截', async () => {
  const result = await fireGroup({ hook: YANG_HOOK, chatId: YANG_CHAT_ID, text: '帮我总结一下顾虑' });
  assert.equal(result?.handled, true);
});

test('fixed_reply：无 sessionKey / 进程重启丢缓存 → fail-open 交给 LLM', async () => {
  const handler = createUserHookHandler(YANG_HOOK);
  handler.onMessageReceived({ content: '总结顾虑' }, {});
  assert.equal(await handler({ text: '总结顾虑' }, {}), undefined);
  const fresh = createUserHookHandler(YANG_HOOK);
  assert.equal(await fresh({ sessionKey: groupSession(YANG_CHAT_ID) }, {}), undefined);
});

// ---------- offer_group（原 wendy-private-group 行为） ----------

function mockFeishuFetch({ existingChatId, existingChatName } = {}) {
  const calls = [];
  const response = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'tok' });
    if (url.includes('/im/v1/chats?') && !options?.method) {
      const items = existingChatId ? [{ chat_id: existingChatId, name: existingChatName || '曹国鸿-后端研发工程师（数据与 AI 应用方向）-Offer决策' }] : [];
      return response({ code: 0, data: { items } });
    }
    if (url.includes('/im/v1/chats') && options?.method === 'POST') {
      return response({ code: 0, data: { chat_id: 'oc_new_group_123' } });
    }
    if (url.includes('/messages?receive_id_type=')) return response({ code: 0, data: { message_id: 'om_test' } });
    if (url.includes('/members')) return response({ code: 0 });
    return response({ code: 0, data: {} });
  };
  return { fetchImpl, calls };
}

const wendyDeps = (fetchImpl) => ({ appId: 'a', appSecret: 'b', fetchImpl });

test('offer_group：私聊 + "为曹国鸿拉群" → 建群 + 发报告卡', async () => {
  const { fetchImpl, calls } = mockFeishuFetch({ existingChatId: null });
  const result = await fireDirect({ hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '为曹国鸿拉群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('曹国鸿'));
  assert.ok(result.reply.text.includes('已建群'));
  assert.ok(result.reply.text.includes('VqxEds9R2oH8gAxJVcacLsEUnge'));
  const sendCall = calls.find((c) => c.url.includes('/messages?receive_id_type='));
  assert.ok(sendCall, '应调 messages 端点发卡');
  assert.ok(sendCall.url.includes('uuid=offer-report-VqxEds9R2oH8gAxJVcacLsEUnge'), '幂等键应固定防重发');
});

test('offer_group：群已存在 → 不建群，只发报告卡', async () => {
  const { fetchImpl, calls } = mockFeishuFetch({ existingChatId: 'oc_existing' });
  const result = await fireDirect({ hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '为曹国鸿建群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('群已存在'));
  assert.equal(calls.find((c) => c.url.includes('/im/v1/chats') && c.options?.method === 'POST'), undefined);
});

test('offer_group：群聊 / 无关键词 / 非配置发送人 → 不触发', async () => {
  const { fetchImpl } = mockFeishuFetch();
  assert.equal(await fireDirect({
    hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '为曹国鸿拉群',
    sessionKey: groupSession('oc_4d7d97cfc99fb5dbb1de518d84b68a2b'),
  }), undefined);
  assert.equal(await fireDirect({
    hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '杨东旭的顾虑是什么',
  }), undefined);
  assert.equal(await fireDirect({
    hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '为曹国鸿拉群',
    senderId: 'ou_99999999999999999999999999999999',
  }), undefined);
});

test('offer_group：拉群但不匹配候选人 → 返回候选人提示', async () => {
  const { fetchImpl } = mockFeishuFetch();
  const result = await fireDirect({ hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '拉群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('目前支持的候选人'));
  assert.ok(result.reply.text.includes('曹国鸿'));
  assert.ok(result.reply.text.includes('杨东旭'));
});

test('offer_group：候选人映射来自配置（"为杨东旭拉群"）', async () => {
  const { fetchImpl } = mockFeishuFetch({ existingChatId: 'oc_yang', existingChatName: '杨东旭-Ai infra-Offer决策' });
  const result = await fireDirect({ hook: WENDY_HOOK, dependencies: wendyDeps(fetchImpl), text: '为杨东旭拉群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('杨东旭'));
});

// ---------- accept_job（原 linda-private-launch 行为） ----------

const lindaDeps = (fetchImpl) => ({ fetchImpl, gatewayToken: 'test-token', assertionSecret: 'a'.repeat(32) });

test('accept_job：私聊 + "接单" → 调 brainx_accept_job + 返回成功', async () => {
  const { fetchImpl, calls } = mockJsonFetch({
    schema_version: 'agent_tool_response.v1',
    data: { job_ref: 'JC3V82F', state: 'ACCEPTED', search: { status: 'triggered' } },
    facts: [], unknowns: [],
  });
  const result = await fireDirect({ hook: LINDA_HOOK, dependencies: lindaDeps(fetchImpl), text: '帮我接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('已接单'));
  assert.ok(result.reply.text.includes('找人'));
  assert.ok(result.reply.text.includes('JC3V82F'));
  const gatewayCall = calls.find((c) => c.url.includes('/brainx_accept_job'));
  assert.ok(gatewayCall, '应调 agent-gateway brainx_accept_job');
  const body = JSON.parse(gatewayCall.options.body);
  assert.equal(body.arguments.job_id, 'JC3V82F');
  assert.equal(body.arguments.confirm, true);
  assert.equal(body.arguments.idempotency_key, 'linda-private-launch-JC3V82F');
});

test('accept_job：已接单（already=true）→ 提示去项目群找人', async () => {
  const { fetchImpl } = mockJsonFetch({
    schema_version: 'agent_tool_response.v1',
    data: { job_ref: 'JC3V82F', state: 'ACCEPTED', already: true, search: null },
    facts: [], unknowns: [],
  });
  const result = await fireDirect({ hook: LINDA_HOOK, dependencies: lindaDeps(fetchImpl), text: '接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('已接单'));
  assert.ok(result.reply.text.includes('项目群'));
});

test('accept_job：网关错误 → 返回失败消息', async () => {
  const { fetchImpl } = mockJsonFetch({
    error: { code: 'NOT_FOUND_OR_FORBIDDEN', message: '当前会话无法读取该对象', retryable: false },
  }, 404);
  const result = await fireDirect({ hook: LINDA_HOOK, dependencies: lindaDeps(fetchImpl), text: '接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('接单失败'));
});

test('accept_job：群聊 / 无关键词 / 非配置发送人 / 丢缓存 → 不触发或 fail-open', async () => {
  const { fetchImpl } = mockJsonFetch({});
  assert.equal(await fireDirect({
    hook: LINDA_HOOK, dependencies: lindaDeps(fetchImpl), text: '接单',
    sessionKey: groupSession('oc_4d7d97cfc99fb5dbb1de518d84b68a2b'),
  }), undefined);
  assert.equal(await fireDirect({
    hook: LINDA_HOOK, dependencies: lindaDeps(fetchImpl), text: '今天天气怎么样',
  }), undefined);
  assert.equal(await fireDirect({
    hook: LINDA_HOOK, dependencies: lindaDeps(fetchImpl), text: '接单',
    senderId: 'ou_99999999999999999999999999999999',
  }), undefined);
  const fresh = createUserHookHandler(LINDA_HOOK, lindaDeps(fetchImpl));
  assert.equal(await fresh({ sessionKey: directSession(LINDA_OPEN_ID), fromId: LINDA_OPEN_ID }, {}), undefined);
});

test('accept_job：纯配置即可开通新顾问（无需改代码）', async () => {
  const newHook = {
    id: 'newbie-private-launch',
    trigger: { session: 'direct', sender_open_id: 'ou_new_consultant', keywords_all: ['接单'] },
    action: { type: 'accept_job', job_id: 'JA00001', job_label: 'JA00001 测试公司 测试职位' },
  };
  const { fetchImpl, calls } = mockJsonFetch({
    schema_version: 'agent_tool_response.v1',
    data: { job_ref: 'JA00001', state: 'ACCEPTED', search: { status: 'triggered' } },
  });
  const result = await fireDirect({ hook: newHook, dependencies: lindaDeps(fetchImpl), text: '接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('JA00001 测试公司 测试职位'));
  const body = JSON.parse(calls.find((c) => c.url.includes('/brainx_accept_job')).options.body);
  assert.equal(body.arguments.job_id, 'JA00001');
  assert.equal(body.arguments.idempotency_key, 'newbie-private-launch-JA00001');
});

test('非法 hook 配置 → createUserHookHandler 直接拒绝', () => {
  assert.throws(() => createUserHookHandler({ id: 'x' }), /USER_HOOK_INVALID/);
  assert.throws(() => createUserHookHandler({
    id: 'x', trigger: { session: 'direct', keywords_all: ['a'] }, action: { type: 'bogus' },
  }), /unknown action\.type/);
});
