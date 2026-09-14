import assert from 'node:assert/strict';
import test from 'node:test';

import { createMentionSilenceHandler } from '../plugins/brainx-openclaw/mention-silence.js';

const GROUP_CHAT = 'oc_g1';
const GROUP_SESSION = `agent:feishu-mia-x:feishu:group:${GROUP_CHAT}`;
const NO_REPLY_RESULT = { handled: true, reply: { text: 'NO_REPLY' }, reason: 'group-no-mention-silence' };
const BOT = 'ou_aa41e31506cb6dbd4bc96e0e48f46b93';

function make({ mentionIds = [] } = {}) {
  let clock = 1_000_000;
  const calls = [];
  const silence = createMentionSilenceHandler({
    now: () => clock,
    appId: 'cli_test',
    appSecret: 's'.repeat(32),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.includes('tenant_access_token')) {
        return { json: async () => ({ code: 0, tenant_access_token: 'tok' }) };
      }
      return { json: async () => ({
        code: 0,
        // 生产真实形态：mentions: [{ id: 'ou_...', id_type: 'open_id', key, name }]，id 为字符串
        data: { items: [{ mentions: mentionIds.map((id) => ({ id, id_type: 'open_id', key: '@_user_1', name: id === BOT ? 'braintex的小机器人' : '某人' })) }] },
      }) };
    },
  });
  return { silence, calls, advance: (ms) => { clock += ms; } };
}

const inbound = (silence, content, messageId = 'om_1') =>
  silence.onMessageReceived({ content, messageId, metadata: { chatId: GROUP_CHAT } },
    { channelId: 'feishu', conversationId: GROUP_CHAT });

test('无标记歧义消息：API 回查命中 @机器人 放行，未命中吞掉', async () => {
  const bot = make({ mentionIds: [BOT] });
  await inbound(bot.silence, '在吗，回复我一下');
  assert.equal(await bot.silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined);
  assert.ok(bot.calls.some((url) => url.includes('/im/v1/messages/om_1')), '歧义消息必须回查 mentions');

  const casual = make({ mentionIds: [] });
  await inbound(casual.silence, '这家外卖真不错');
  assert.deepEqual(await casual.silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }),
    NO_REPLY_RESULT);
});

test('@别人（content 保留 at 标签）不回查 API，直接吞掉', async () => {
  const { silence, calls } = make();
  await inbound(silence, '<at user_id="ou_someone_else"></at> 吃饭吗');
  assert.deepEqual(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }),
    NO_REPLY_RESULT);
  assert.equal(calls.length, 0, '@别人 标签本地可判，无需 API');
});

test('按钮命令与控制命令不回查直接放行；「找人条件」静默', async () => {
  const { silence, calls } = make();
  for (const body of [
    '[BRAINTEX_SEARCH_START] 为项目 J1 使用 OpenMai 继续找人。',
    '把项目 J1 的候选人 c-1 标记为重点关注。现在调用 brainx_candidate_workflow',
    '/brainx',
  ]) {
    await inbound(silence, body);
    assert.equal(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined, body);
  }
  assert.equal(calls.length, 0);
  await inbound(silence, '找人条件：北京、半导体');
  assert.deepEqual(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }),
    NO_REPLY_RESULT);
});

test('API 失败按未 @ 处理（宁可静默）；追问窗口内放行', async () => {
  let clock = 1_000_000;
  const silence = createMentionSilenceHandler({
    now: () => clock,
    appId: 'cli_test', appSecret: 's'.repeat(32),
    fetchImpl: async () => { throw new Error('network down'); },
  });
  const advance = (ms) => { clock += ms; };
  const send = (content) => silence.onMessageReceived({ content, messageId: 'om_x', metadata: { chatId: GROUP_CHAT } },
    { channelId: 'feishu', conversationId: GROUP_CHAT });
  await send('在吗');
  assert.deepEqual(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }),
    NO_REPLY_RESULT, 'API 失败宁可静默');

  // 可见动作开窗口：用带标记命令开路，随后普通追问放行
  await send('/brainx');
  advance(3 * 60 * 1000);
  await send('确认，就是这个');
  assert.equal(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined);
  advance(11 * 60 * 1000);
  await send('大家中午吃啥');
  assert.deepEqual(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }),
    NO_REPLY_RESULT);
});

test('私聊不适用；无入站记录 fail-open', async () => {
  const { silence } = make();
  assert.equal(await silence.onBeforeAgentReply({ cleanedBody: 'x' },
    { sessionKey: 'agent:x:feishu:mia:direct:ou_u1' }), undefined);
  assert.equal(await silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined);
});
