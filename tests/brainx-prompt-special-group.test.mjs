import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBraintexPromptContext, preloadSpecialGroupDoc, getSpecialGroupDocId,
  _resetDocCacheForTests,
} from '../plugins/brainx-openclaw/prompt.js';

const YANG_CHAT_ID = 'oc_4d7d97cfc99fb5dbb1de518d84b68a2b';
const YANG_DOC_ID = 'TrFHdPfc3oXzyLxa2TRcVxQvn6b';
const OTHER_CHAT_ID = 'oc_other_group_0000000000000000000000';

const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

function mockFetchReturning(content) {
  return async (url) => {
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'tok' });
    if (url.includes('/raw_content')) return response({ code: 0, data: { content } });
    return response({ code: 0, data: {} });
  };
}

test('getSpecialGroupDocId：杨东旭群返回文档 token，其他群返回 null', () => {
  assert.equal(getSpecialGroupDocId(YANG_CHAT_ID), YANG_DOC_ID);
  assert.equal(getSpecialGroupDocId(OTHER_CHAT_ID), null);
  assert.equal(getSpecialGroupDocId(null), null);
});

test('createBraintexPromptContext：非 feishu channel 直接返回 undefined', () => {
  _resetDocCacheForTests();
  const result = createBraintexPromptContext({ channel: 'wechat', conversationId: YANG_CHAT_ID });
  assert.equal(result, undefined);
});

test('createBraintexPromptContext：缓存未命中时只返回 base prompt（fail-open）', () => {
  _resetDocCacheForTests();
  const result = createBraintexPromptContext({ channel: 'feishu', conversationId: YANG_CHAT_ID });
  assert.ok(result);
  assert.equal(result.includes('本群专属背景信息'), false);
});

test('createBraintexPromptContext：非映射群 chat_id 不注入文档', async () => {
  _resetDocCacheForTests();
  await preloadSpecialGroupDoc(OTHER_CHAT_ID, {
    appId: 'a', appSecret: 'b',
    fetchImpl: mockFetchReturning('不该被注入的内容'),
  });
  const result = createBraintexPromptContext({ channel: 'feishu', conversationId: OTHER_CHAT_ID });
  assert.ok(result);
  assert.equal(result.includes('本群专属背景信息'), false);
});

test('preloadSpecialGroupDoc + createBraintexPromptContext：杨东旭群缓存命中后注入文档正文，且不暴露来源', async () => {
  _resetDocCacheForTests();
  await preloadSpecialGroupDoc(YANG_CHAT_ID, {
    appId: 'a', appSecret: 'b',
    fetchImpl: mockFetchReturning('候选人意愿度 9/10，目标公司超衍智能'),
  });
  const result = createBraintexPromptContext({ channel: 'feishu', conversationId: YANG_CHAT_ID });
  // 文档正文要注入
  assert.ok(result.includes('候选人意愿度 9/10'));
  assert.ok(result.includes('超衍智能'));
  // 隐蔽约束（咪 2026-09-16 拍板）：不向用户暴露信息来源、读取状态、缓存机制
  assert.equal(result.includes('飞书文档'), false, '不得暴露"飞书文档"字样');
  assert.equal(result.includes('实时同步'), false, '不得暴露"实时同步"读取机制');
  assert.equal(result.includes('缓存'), false, '不得暴露"缓存"机制');
  assert.equal(result.includes('未在文档中'), false, '不得暴露"未在文档中"读取状态');
  assert.equal(result.includes('未在背景文档中'), false, '不得暴露"未在背景文档中"');
  assert.equal(result.includes('读不到'), false, '不得说"读不到"');
  assert.equal(result.includes('我没有这份报告'), false, '不得说"我没有这份报告"');
});

test('preloadSpecialGroupDoc：凭据缺失静默跳过，缓存仍为空', async () => {
  _resetDocCacheForTests();
  // 不传 appId/appSecret，process.env 也没有，应该静默跳过
  await preloadSpecialGroupDoc(YANG_CHAT_ID, { fetchImpl: mockFetchReturning('不该被注入的内容') });
  const result = createBraintexPromptContext({ channel: 'feishu', conversationId: YANG_CHAT_ID });
  assert.equal(result.includes('本群业务上下文'), false);
});

test('preloadSpecialGroupDoc：飞书 API 失败时静默降级，下一条消息仍可重试', async () => {
  _resetDocCacheForTests();
  const failingFetch = async (url) => {
    if (url.includes('tenant_access_token')) return response({ code: 0, tenant_access_token: 'tok' });
    return response({ code: 99991661, msg: 'permission denied' });
  };
  await preloadSpecialGroupDoc(YANG_CHAT_ID, { appId: 'a', appSecret: 'b', fetchImpl: failingFetch });
  const result = createBraintexPromptContext({ channel: 'feishu', conversationId: YANG_CHAT_ID });
  assert.equal(result.includes('本群专属背景信息'), false);
});

test('createBraintexPromptContext：sessionKey 形如 feishu:group:oc_xxx 也能提取 chat_id', async () => {
  _resetDocCacheForTests();
  await preloadSpecialGroupDoc(YANG_CHAT_ID, {
    appId: 'a', appSecret: 'b',
    fetchImpl: mockFetchReturning('sessionKey 路径也能识别'),
  });
  const result = createBraintexPromptContext({
    channel: 'feishu',
    sessionKey: `feishu:group:${YANG_CHAT_ID}`,
  });
  assert.ok(result.includes('sessionKey 路径也能识别'));
});
