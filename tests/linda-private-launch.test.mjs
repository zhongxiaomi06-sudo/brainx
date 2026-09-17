import assert from 'node:assert/strict';
import test from 'node:test';
import { createLindaPrivateLaunchHandler, LINDA_OPEN_ID, REHEARSAL_PROJECT_ID } from '../plugins/brainx-openclaw/linda-private-launch.js';

function mockFetch(responseBody, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(responseBody), {
      status, headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

// 生产 sessionKey 格式：agent:feishu-mia-<hash>:feishu:mia:direct:<open_id>
const DIRECT_SESSION = `agent:feishu-mia-abc123:feishu:mia:direct:${LINDA_OPEN_ID}`;
const GROUP_SESSION = 'agent:feishu-mia-abc123:feishu:mia:group:oc_4d7d97cfc99fb5dbb1de518d84b68a2b';

function makeReceivedEvent({ sessionKey, text, senderId }) {
  return { sessionKey, content: text, fromId: senderId };
}
function makeReplyEvent({ sessionKey, senderId }) {
  return { sessionKey, fromId: senderId };
}

async function fireAndReply({ fetchImpl, text, senderId = LINDA_OPEN_ID, sessionKey = DIRECT_SESSION, context = {} }) {
  const handler = createLindaPrivateLaunchHandler({
    fetchImpl,
    gatewayToken: 'test-token',
    assertionSecret: 'a'.repeat(32),
  });
  handler.onMessageReceived(makeReceivedEvent({ sessionKey, text, senderId }), context);
  return handler(makeReplyEvent({ sessionKey, senderId }), context);
}

test('私聊 + "接单" → 调 brainx_accept_job + 返回成功', async () => {
  const { fetchImpl, calls } = mockFetch({
    schema_version: 'agent_tool_response.v1',
    data: { job_ref: REHEARSAL_PROJECT_ID, state: 'ACCEPTED', search: { status: 'triggered' } },
    facts: [], unknowns: [],
  });
  const result = await fireAndReply({ fetchImpl, text: '帮我接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('已接单'));
  assert.ok(result.reply.text.includes('找人'));
  assert.ok(result.reply.text.includes(REHEARSAL_PROJECT_ID));
  const gatewayCall = calls.find((c) => c.url.includes('/brainx_accept_job'));
  assert.ok(gatewayCall, '应调 agent-gateway brainx_accept_job');
  const body = JSON.parse(gatewayCall.options.body);
  assert.equal(body.arguments.job_id, REHEARSAL_PROJECT_ID);
  assert.equal(body.arguments.confirm, true);
});

test('私聊 + 已接单（dup 路径）→ 仍触发找人', async () => {
  const { fetchImpl } = mockFetch({
    schema_version: 'agent_tool_response.v1',
    data: { job_ref: REHEARSAL_PROJECT_ID, state: 'ACCEPTED', search: { status: 'triggered' } },
    facts: [], unknowns: [],
  });
  const result = await fireAndReply({ fetchImpl, text: '接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('找人'));
});

test('私聊 + 409 冲突（already=true, search=null）→ 提示去群里找人', async () => {
  const { fetchImpl } = mockFetch({
    schema_version: 'agent_tool_response.v1',
    data: { job_ref: REHEARSAL_PROJECT_ID, state: 'ACCEPTED', already: true, search: null },
    facts: [], unknowns: [],
  });
  const result = await fireAndReply({ fetchImpl, text: '接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('已接单'));
  assert.ok(result.reply.text.includes('项目群'));
});

test('私聊 + 网关错误 → 返回失败消息', async () => {
  const { fetchImpl } = mockFetch({
    error: { code: 'NOT_FOUND_OR_FORBIDDEN', message: '当前会话无法读取该对象', retryable: false },
  }, 404);
  const result = await fireAndReply({ fetchImpl, text: '接单' });
  assert.equal(result.handled, true);
  assert.ok(result.reply.text.includes('接单失败'));
});

test('非私聊（群聊）→ 不触发', async () => {
  const { fetchImpl } = mockFetch({});
  const result = await fireAndReply({ fetchImpl, text: '接单', sessionKey: GROUP_SESSION });
  assert.equal(result, undefined);
});

test('私聊但不含"接单" → 不触发', async () => {
  const { fetchImpl } = mockFetch({});
  const result = await fireAndReply({ fetchImpl, text: '今天天气怎么样' });
  assert.equal(result, undefined);
});

test('非 linda 发送者 → 不触发', async () => {
  const { fetchImpl } = mockFetch({});
  const otherId = 'ou_99999999999999999999999999999999';
  const result = await fireAndReply({ fetchImpl, text: '接单', senderId: otherId });
  assert.equal(result, undefined);
});

test('进程重启丢入站缓存 → fail-open（返回 undefined 交给 LLM）', async () => {
  const { fetchImpl } = mockFetch({});
  const handler = createLindaPrivateLaunchHandler({
    fetchImpl, gatewayToken: 't', assertionSecret: 'a'.repeat(32),
  });
  const result = await handler(
    makeReplyEvent({ sessionKey: DIRECT_SESSION, senderId: LINDA_OPEN_ID }),
    {},
  );
  assert.equal(result, undefined);
});
