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
