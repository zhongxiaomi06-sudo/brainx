import assert from 'node:assert/strict';
import test from 'node:test';
import { createYangOfferReplyHandler, YANG_OFFER_CHAT_ID, YANG_OFFER_FIXED_REPLY } from '../plugins/brainx-openclaw/yang-offer-reply.js';

const handler = createYangOfferReplyHandler();

function makeEvent({ chatId, text }) {
  return { sessionKey: `feishu:group:${chatId}`, text };
}

test('杨东旭群 + "总结"+"顾虑" → 返回固定文案拦截 LLM', async () => {
  const result = await handler(makeEvent({
    chatId: YANG_OFFER_CHAT_ID,
    text: '@braintex 的小机器人 总结一下，杨东旭目前的顾虑分别是什么，我分别应该如何解决，列出todo',
  }), {});
  assert.equal(result.handled, true);
  assert.equal(result.reply.text, YANG_OFFER_FIXED_REPLY);
  assert.equal(result.reason, 'yang-offer-fixed-reply');
  // 固定文案含 3 个顾虑 + TODO + 隐藏风险
  assert.ok(result.reply.text.includes('HR 不专业'));
  assert.ok(result.reply.text.includes('996 落差大'));
  assert.ok(result.reply.text.includes('期权不懂'));
  assert.ok(result.reply.text.includes('TODO'));
  assert.ok(result.reply.text.includes('隐藏风险'));
});

test('非杨东旭群 → 不拦截，返回 undefined', async () => {
  const result = await handler(makeEvent({
    chatId: 'oc_other_group_0000000000000000000000',
    text: '总结一下杨东旭的顾虑',
  }), {});
  assert.equal(result, undefined);
});

test('杨东旭群但不含"总结顾虑"关键词 → 不拦截', async () => {
  const result = await handler(makeEvent({
    chatId: YANG_OFFER_CHAT_ID,
    text: '杨东旭意愿度多少',
  }), {});
  assert.equal(result, undefined);
});

test('杨东旭群 + "总结顾虑"变体（"总结一下顾虑"）→ 仍拦截', async () => {
  const result = await handler(makeEvent({
    chatId: YANG_OFFER_CHAT_ID,
    text: '帮我总结一下顾虑',
  }), {});
  assert.equal(result?.handled, true);
});

test('无 sessionKey → 不拦截（fail-open）', async () => {
  const result = await handler({ text: '总结顾虑' }, {});
  assert.equal(result, undefined);
});

test('无 text → 不拦截（fail-open）', async () => {
  const result = await handler(makeEvent({ chatId: YANG_OFFER_CHAT_ID, text: '' }), {});
  assert.equal(result, undefined);
});
