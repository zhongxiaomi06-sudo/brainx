import assert from 'node:assert/strict';
import test from 'node:test';

import { createMentionSilenceHandler } from '../plugins/brainx-openclaw/mention-silence.js';

const GROUP_CHAT = 'oc_g1';
const GROUP_SESSION = `agent:feishu-mia-x:feishu:group:${GROUP_CHAT}`;
const P2P_SESSION = 'agent:feishu-mia-x:feishu:mia:direct:ou_u1';
const NO_REPLY_RESULT = { handled: true, reply: { text: 'NO_REPLY' }, reason: 'group-no-mention-silence' };

function make() {
  let clock = 1_000_000;
  const silence = createMentionSilenceHandler({ now: () => clock });
  return { silence, advance: (ms) => { clock += ms; } };
}

const BOT = 'ou_aa41e31506cb6dbd4bc96e0e48f46b93'; // braintex 小机器人 bot open_id

const inbound = (silence, content, chatId = GROUP_CHAT) =>
  silence.onMessageReceived({ content, metadata: { chatId } }, { channelId: 'feishu', conversationId: chatId });

test('群内没有 @ 的闲聊回复被短路为 NO_REPLY，@ 机器人的消息回复照常', () => {
  const { silence } = make();
  inbound(silence, '推人选的时候，要不然叫Reloop');
  assert.deepEqual(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), NO_REPLY_RESULT);
  inbound(silence, `<at user_id="${BOT}"></at> 今天先做什么`);
  assert.equal(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined);
  inbound(silence, '@braintex的小机器人 在吗');
  assert.equal(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined,
    '飞书把 @机器人 渲染成纯文本名时也要识别（生产实证形态）');
});

test('@ 别人不算 @ 机器人（硬规则一：没点机器人名就不出声）', () => {
  const { silence } = make();
  inbound(silence, '<at user_id="ou_someone_else"></at> 这个候选人你觉得怎么样');
  assert.deepEqual(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), NO_REPLY_RESULT);
});

test('「找人条件：…」不再回声——静默记录，由搜索启动时注入（硬规则一/三）', () => {
  const { silence } = make();
  inbound(silence, '找人条件：北京、半导体、总监');
  assert.deepEqual(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), NO_REPLY_RESULT);
});

test('按钮命令（标记或工具指令）、控制命令触发的回复放行', () => {
  const { silence } = make();
  for (const body of [
    '[BRAINTEX_SEARCH_START] 为项目 J1 使用 OpenMai 继续找人。',
    '[BRAINTEX_CANDIDATE_KEEP] 职位 J1 候选人 c-1',
    '把项目 J1 的候选人 c-1 标记为重点关注。现在调用 brainx_candidate_workflow',
    '为当前群绑定一个职位。先调用 brainx_bind_group_project',
    '/brainx',
  ]) {
    inbound(silence, body);
    assert.equal(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined, body);
  }
});

test('可见动作后的 10 分钟内追问放行，超过窗口恢复沉默', () => {
  const { silence, advance } = make();
  inbound(silence, `<at user_id="${BOT}"></at> 帮我接 J1`);
  advance(3 * 60 * 1000);
  inbound(silence, '确认，就是这个');
  assert.equal(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined,
    '10 分钟窗口内的会话追问不能掐断');
  advance(11 * 60 * 1000);
  inbound(silence, '大家中午吃啥');
  assert.deepEqual(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), NO_REPLY_RESULT);
});

test('私聊不适用沉默纪律；无入站记录 fail-open 不错杀', () => {
  const { silence } = make();
  assert.equal(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: P2P_SESSION }), undefined);
  assert.equal(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: GROUP_SESSION }), undefined,
    '进程重启丢入站记录时宁可放过');
});

test('入站 sessionKey 缺失也能关联（裸 oc_ 与 chat: 前缀两种 conversationId 形态）', () => {
  const { silence } = make();
  silence.onMessageReceived({ content: '随便聊聊', metadata: { chatId: 'oc_g2' } },
    { channelId: 'feishu', conversationId: 'oc_g2' });
  assert.deepEqual(silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: 'agent:feishu-mia-x:feishu:group:oc_g2' }),
    NO_REPLY_RESULT);

  // 2026-09-14 生产探针实证：conversationId 实际为 "chat:oc_..." 前缀形态
  const probe = make();
  probe.silence.onMessageReceived(
    { content: '再聊一句', metadata: { to: 'chat:oc_g3', senderId: 'ou_x' } },
    { channelId: 'feishu', conversationId: 'chat:oc_g3' });
  assert.deepEqual(probe.silence.onBeforeAgentReply({ cleanedBody: 'x' }, { sessionKey: 'agent:feishu-mia-x:feishu:group:oc_g3' }),
    NO_REPLY_RESULT);
});
