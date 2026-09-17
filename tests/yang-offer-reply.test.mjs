import assert from 'node:assert/strict';
import test from 'node:test';
import { createYangOfferReplyHandler, YANG_OFFER_CHAT_ID, YANG_OFFER_FIXED_REPLY } from '../plugins/brainx-openclaw/yang-offer-reply.js';

// 新模式：handler 返回 { onMessageReceived, (before_agent_reply) }。
// 测试需先调 onMessageReceived 缓存入站文本，再调 handler 本身（before_agent_reply）。
const handler = createYangOfferReplyHandler();

function makeReceivedEvent({ chatId, text }) {
  return {
    sessionKey: `agent:feishu-mia-abc:feishu:mia:group:${chatId}`,
    content: text,
    metadata: { chatId },
  };
}

function makeReplyEvent({ chatId }) {
  return { sessionKey: `agent:feishu-mia-abc:feishu:mia:group:${chatId}` };
}

async function fireAndReply({ chatId, text }) {
  handler.onMessageReceived(makeReceivedEvent({ chatId, text }), { conversationId: chatId });
  return handler(makeReplyEvent({ chatId }), {});
}

test('杨东旭群 + "总结"+"顾虑" → 返回固定文案拦截 LLM', async () => {
  const result = await fireAndReply({
    chatId: YANG_OFFER_CHAT_ID,
    text: '@braintex 的小机器人 总结一下，杨东旭目前的顾虑分别是什么，我分别应该如何解决，列出todo',
  });
  assert.equal(result.handled, true);
  assert.equal(result.reply.text, YANG_OFFER_FIXED_REPLY);
  assert.equal(result.reason, 'yang-offer-fixed-reply');
  assert.ok(result.reply.text.includes('P0｜紧急'));
  assert.ok(result.reply.text.includes('P1｜推进中'));
  assert.ok(result.reply.text.includes('修复 HR 专业度 gap'));
  assert.ok(result.reply.text.includes('996 vs 薪资期权匹配话术'));
  assert.ok(result.reply.text.includes('CEO 三面讲解期权方案'));
  assert.ok(result.reply.text.includes('checklist'));
});

test('非杨东旭群 → 不拦截，返回 undefined', async () => {
  const result = await fireAndReply({
    chatId: 'oc_other_group_0000000000000000000000',
    text: '总结一下杨东旭的顾虑',
  });
  assert.equal(result, undefined);
});

test('杨东旭群但不含"总结顾虑"关键词 → 不拦截', async () => {
  const result = await fireAndReply({
    chatId: YANG_OFFER_CHAT_ID,
    text: '杨东旭意愿度多少',
  });
  assert.equal(result, undefined);
});

test('杨东旭群 + "总结顾虑"变体（"总结一下顾虑"）→ 仍拦截', async () => {
  const result = await fireAndReply({
    chatId: YANG_OFFER_CHAT_ID,
    text: '帮我总结一下顾虑',
  });
  assert.equal(result?.handled, true);
});

test('无 sessionKey → 不拦截（fail-open）', async () => {
  handler.onMessageReceived({ content: '总结顾虑' }, {});
  const result = await handler({ text: '总结顾虑' }, {});
  assert.equal(result, undefined);
});

test('进程重启丢入站记录 → fail-open 交给 LLM', async () => {
  // 用全新 handler 实例（无缓存），模拟进程重启后的状态
  const freshHandler = createYangOfferReplyHandler();
  const result = await freshHandler(makeReplyEvent({ chatId: YANG_OFFER_CHAT_ID }), {});
  assert.equal(result, undefined);
});
