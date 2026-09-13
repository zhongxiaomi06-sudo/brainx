import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createSearchStartNoticeHandler,
  parseSearchStartNotice,
} from '../plugins/brainx-openclaw/search-start-notice.js';

test('找人卡片命令可解析新版标记、旧卡片和继续找人', () => {
  assert.deepEqual(
    parseSearchStartNotice('[BRAINTEX_SEARCH_START] 为项目 JGHTW36 使用 OpenMai 找人。现在调用工具'),
    {
      projectRef: 'JGHTW36', entry: 'OpenMai', continuing: false,
      text: '🔎 正在处理 OpenMai 找人请求，通常需要 3–5 分钟；完成后候选人会自动发到本群。',
    },
  );
  assert.equal(parseSearchStartNotice('为项目 P_2 使用 SuperMai 继续找人。现在调用工具')?.continuing, true);
  assert.equal(parseSearchStartNotice('找人条件：北京，五年经验'), null);
});

test('飞书群卡片点击立即发送文字状态，并按消息幂等', async () => {
  const sent = [];
  const api = {
    config: { fallback: true },
    runtime: {
      config: { current: () => ({ live: true }) },
      channel: { outbound: { loadAdapter: async (channel) => {
        assert.equal(channel, 'feishu');
        return { sendText: async (input) => { sent.push(input); } };
      } } },
    },
  };
  const handler = createSearchStartNoticeHandler(api);
  const event = {
    content: '为项目 JGHTW36 使用 OpenMai 找人。旧卡片命令仍要支持',
    messageId: 'om_action_1',
  };
  const context = { channelId: 'feishu', conversationId: 'oc_project', accountId: 'default' };
  assert.equal(await handler(event, context), true);
  assert.equal(await handler(event, context), false);
  assert.deepEqual(sent, [{
    cfg: { live: true }, to: 'oc_project', accountId: 'default',
    text: '🔎 正在处理 OpenMai 找人请求，通常需要 3–5 分钟；完成后候选人会自动发到本群。',
  }]);
});

test('非飞书或私聊不发送项目群状态，发送失败不阻断 Agent', async () => {
  const warnings = [];
  const api = {
    runtime: {
      channel: { outbound: { loadAdapter: async () => ({
        sendText: async () => { throw new Error('temporary'); },
      }) } },
    },
    logger: { warn: (message) => warnings.push(message) },
  };
  const handler = createSearchStartNoticeHandler(api);
  const event = { content: '[BRAINTEX_SEARCH_START] 为项目 P1 使用 SuperMai 找人。', messageId: 'om_2' };
  assert.equal(await handler(event, { channelId: 'telegram', conversationId: 'oc_x' }), false);
  assert.equal(await handler(event, { channelId: 'feishu', conversationId: 'ou_private' }), false);
  assert.equal(await handler(event, { channelId: 'feishu', conversationId: 'oc_x' }), false);
  assert.match(warnings[0], /delivery failed: temporary/);
});

test('继续找人按钮命令被插件确定性直调，continue_search 不经过模型', async () => {
  const sent = [];
  const calls = [];
  const api = {
    runtime: {
      channel: { outbound: { loadAdapter: async () => ({
        sendText: async (input) => { sent.push(input); },
      }) } },
    },
    logger: { warn: () => {} },
  };
  const secret = 's'.repeat(40);
  const handler = createSearchStartNoticeHandler(api, {
    gatewayToken: 't'.repeat(40),
    assertionSecret: secret,
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ schema_version: 'agent_tool_response.v1', ok: true }) };
    },
  });
  const event = {
    content: '[BRAINTEX_SEARCH_START] 为项目 JM26DGW 使用 OpenMai 继续找人。读取本群最近一条由顾问明确发送的“找人条件：”作为可选补充条件；现在第一次调用 brainx_openmai_search，传入 job_id=JM26DGW 和 continue_search=true。',
    messageId: 'card-action-1',
    senderId: 'ou_clicker',
  };
  const context = { channelId: 'feishu', conversationId: 'oc_project', accountId: 'mia' };
  assert.equal(await handler(event, context), true);
  assert.equal(calls.length, 1, '按钮命令必须由插件直调一次网关');
  assert.match(calls[0].url, /\/brainx_openmai_search$/);
  assert.deepEqual(calls[0].body.arguments, { job_id: 'JM26DGW', continue_search: true });
  assert.equal(calls[0].body.schema_version, 'agent_tool_request.v1');
  assert.equal(sent.length, 1, '状态通知仍然要发');
});

test('SuperMai 继续找人映射到对应工具；首次找人 continue_search 为 false', async () => {
  const calls = [];
  const api = {
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async () => {} }) } } },
    logger: { warn: () => {} },
  };
  const handler = createSearchStartNoticeHandler(api, {
    gatewayToken: 't'.repeat(40),
    assertionSecret: 's'.repeat(40),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: true }) };
    },
  });
  await handler({ content: '[BRAINTEX_SEARCH_START] 为项目 P1 使用 SuperMai 继续找人。', messageId: 'a1', senderId: 'ou_1' },
    { channelId: 'feishu', conversationId: 'oc_g', accountId: 'mia' });
  await handler({ content: '为项目 P2 使用 OpenMai 找人。', messageId: 'a2', senderId: 'ou_1' },
    { channelId: 'feishu', conversationId: 'oc_g', accountId: 'mia' });
  assert.match(calls[0].url, /\/brainx_supermai_scout$/);
  assert.deepEqual(calls[0].body.arguments, { job_id: 'P1', continue_search: true });
  assert.match(calls[1].url, /\/brainx_openmai_search$/);
  assert.deepEqual(calls[1].body.arguments, { job_id: 'P2', continue_search: false });
});

test('取不到点击人时不直调，留给 agent 按命令文本兜底；网关拒绝只记警告', async () => {
  const calls = [];
  const warnings = [];
  const api = {
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText: async () => {} }) } } },
    logger: { warn: (message) => warnings.push(message) },
  };
  const handler = createSearchStartNoticeHandler(api, {
    gatewayToken: 't'.repeat(40),
    assertionSecret: 's'.repeat(40),
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { json: async () => ({ ok: false, error: { code: 'NOT_FOUND_OR_FORBIDDEN' } }) };
    },
  });
  // 无 senderId/metadata.senderId（from 是群 id）：不直调
  const noSender = await handler(
    { content: '为项目 P1 使用 OpenMai 继续找人。', messageId: 'b1', from: 'oc_g' },
    { channelId: 'feishu', conversationId: 'oc_g', accountId: 'mia' });
  assert.equal(noSender, true, '通知照发');
  assert.equal(calls.length, 0, '无点击人标识时不构造 principal 直调');
  // 有点击人但网关拒绝：记警告不抛出
  const refused = await handler(
    { content: '为项目 P2 使用 OpenMai 继续找人。', messageId: 'b2', senderId: 'ou_1' },
    { channelId: 'feishu', conversationId: 'oc_g', accountId: 'mia' });
  assert.equal(refused, true);
  assert.equal(calls.length, 1);
  assert.ok(warnings.some((message) => /direct search start refused: NOT_FOUND_OR_FORBIDDEN/.test(message)));
});
