import assert from 'node:assert/strict';
import test from 'node:test';
import { createWendyPrivateGroupHandler, CANDIDATE_GROUP_MAP, WENDY_OPEN_ID } from '../plugins/brainx-openclaw/wendy-private-group.js';

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function mockFetch({ existingChatId, existingChatName } = {}) {
  const calls = [];
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

// 生产 sessionKey 格式：agent:feishu-mia-<hash>:feishu:mia:direct:<open_id>
const DIRECT_SESSION = `agent:feishu-mia-abc123:feishu:mia:direct:${WENDY_OPEN_ID}`;
const GROUP_SESSION = 'agent:feishu-mia-abc123:feishu:mia:group:oc_4d7d97cfc99fb5dbb1de518d84b68a2b';

function makeReceivedEvent({ sessionKey, text, senderId }) {
  return { sessionKey, content: text, fromId: senderId };
}
function makeReplyEvent({ sessionKey, senderId }) {
  return { sessionKey, fromId: senderId };
}

async function fireAndReply({ fetchImpl, text, senderId = WENDY_OPEN_ID, sessionKey = DIRECT_SESSION, context = {} }) {
  const handler = createWendyPrivateGroupHandler({ appId: 'a', appSecret: 'b', fetchImpl });
  handler.onMessageReceived(makeReceivedEvent({ sessionKey, text, senderId }), context);
  return handler(makeReplyEvent({ sessionKey, senderId }), context);
}

test('私聊 + "为曹国鸿拉群" → 建群 + 发报告卡', async () => {
  const { fetchImpl, calls } = mockFetch({ existingChatId: null });
  const result = await fireAndReply({ fetchImpl, text: '为曹国鸿拉群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('曹国鸿'));
  assert.ok(result.reply.text.includes('已建群'));
  assert.ok(result.reply.text.includes('VqxEds9R2oH8gAxJVcacLsEUnge'));
  const sendCall = calls.find((c) => c.url.includes('/messages?receive_id_type='));
  assert.ok(sendCall, '应调 messages 端点发卡');
  assert.ok(sendCall.url.includes('uuid=offer-report-VqxEds9R2oH8gAxJVcacLsEUnge'), '幂等键应固定防重发');
});

test('私聊 + 群已存在 → 不建群，只发报告卡', async () => {
  const { fetchImpl, calls } = mockFetch({ existingChatId: 'oc_existing' });
  const result = await fireAndReply({ fetchImpl, text: '为曹国鸿建群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('群已存在'));
  const createCall = calls.find((c) => c.url.includes('/im/v1/chats') && c.options?.method === 'POST');
  assert.equal(createCall, undefined);
});

test('非私聊（群聊）→ 不触发', async () => {
  const { fetchImpl } = mockFetch();
  const result = await fireAndReply({
    fetchImpl, text: '为曹国鸿拉群', sessionKey: GROUP_SESSION,
  });
  assert.equal(result, undefined);
});

test('私聊但不含"拉群/建群"关键词 → 不触发', async () => {
  const { fetchImpl } = mockFetch();
  const result = await fireAndReply({ fetchImpl, text: '杨东旭的顾虑是什么' });
  assert.equal(result, undefined);
});

test('私聊 + 拉群但不匹配候选人 → 返回提示', async () => {
  const { fetchImpl } = mockFetch();
  const result = await fireAndReply({ fetchImpl, text: '拉群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('目前支持的候选人'));
});

test('私聊 + "为杨东旭拉群" → 也能触发', async () => {
  const { fetchImpl } = mockFetch({ existingChatId: 'oc_yang', existingChatName: '杨东旭-Ai infra-Offer决策' });
  const result = await fireAndReply({ fetchImpl, text: '为杨东旭拉群' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('杨东旭'));
});

test('非 wendy 发送者 → 不触发', async () => {
  const { fetchImpl } = mockFetch();
  const otherId = 'ou_99999999999999999999999999999999';
  const result = await fireAndReply({
    fetchImpl, text: '为曹国鸿拉群', senderId: otherId,
  });
  assert.equal(result, undefined);
});
