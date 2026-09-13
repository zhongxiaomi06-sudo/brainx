import assert from 'node:assert/strict';
import test from 'node:test';

import { createMentionSilenceHandler } from '../plugins/brainx-openclaw/mention-silence.js';

const GROUP_CHAT = 'oc_g1';
const GROUP_SESSION = `agent:feishu-mia-x:feishu:group:${GROUP_CHAT}`;
const P2P_SESSION = 'agent:feishu-mia-x:feishu:mia:direct:ou_u1';

function make() {
  let clock = 1_000_000;
  const silence = createMentionSilenceHandler({ now: () => clock });
  return { silence, advance: (ms) => { clock += ms; } };
}

const inbound = (silence, content, chatId = GROUP_CHAT) =>
  silence.onMessageReceived({ content, metadata: { chatId } }, { channelId: 'feishu', conversationId: chatId });

test('群内没有 @ 的闲聊回复被取消，@ 消息的回复照常', () => {
  const { silence } = make();
  inbound(silence, '推人选的时候，要不然叫Reloop');
  assert.deepEqual(
    silence.onReplySending({ sessionKey: GROUP_SESSION, kind: 'final' }),
    { cancel: true, reason: 'group-no-mention-silence' });
  inbound(silence, '<at user_id="ou_bot"></at> 今天先做什么');
  assert.equal(silence.onReplySending({ sessionKey: GROUP_SESSION, kind: 'final' }), undefined);
});

test('按钮命令（标记或工具指令）、控制命令、找人条件触发的回复放行', () => {
  const { silence } = make();
  for (const body of [
    '[BRAINTEX_SEARCH_START] 为项目 J1 使用 OpenMai 继续找人。',
    '[BRAINTEX_CANDIDATE_KEEP] 职位 J1 候选人 c-1',
    '把项目 J1 的候选人 c-1 标记为重点关注。现在调用 brainx_candidate_workflow',
    '为当前群绑定一个职位。先调用 brainx_bind_group_project',
    '/brainx',
    '找人条件：北京、半导体、总监',
  ]) {
    inbound(silence, body);
    assert.equal(silence.onReplySending({ sessionKey: GROUP_SESSION, kind: 'final' }), undefined, body);
  }
});

test('可见动作后的 10 分钟内追问放行，超过窗口恢复沉默', () => {
  const { silence, advance } = make();
  inbound(silence, '<at user_id="ou_bot"></at> 帮我接 J1');
  advance(3 * 60 * 1000);
  inbound(silence, '确认，就是这个');
  assert.equal(silence.onReplySending({ sessionKey: GROUP_SESSION, kind: 'final' }), undefined,
    '10 分钟窗口内的会话追问不能掐断');
  advance(11 * 60 * 1000);
  inbound(silence, '大家中午吃啥');
  assert.deepEqual(silence.onReplySending({ sessionKey: GROUP_SESSION, kind: 'final' }),
    { cancel: true, reason: 'group-no-mention-silence' });
});

test('私聊不适用沉默纪律；无入站记录 fail-open 不错杀', () => {
  const { silence } = make();
  assert.equal(silence.onReplySending({ sessionKey: P2P_SESSION, kind: 'final' }), undefined);
  assert.equal(silence.onReplySending({ sessionKey: GROUP_SESSION, kind: 'final' }), undefined,
    '进程重启丢入站记录时宁可放过');
});

test('入站 sessionKey 缺失也能关联（用 conversationId/metadata.chatId）', () => {
  const { silence } = make();
  silence.onMessageReceived({ content: '随便聊聊', metadata: { chatId: 'oc_g2' } },
    { channelId: 'feishu', conversationId: 'oc_g2' });
  assert.deepEqual(
    silence.onReplySending({ sessionKey: 'agent:feishu-mia-x:feishu:group:oc_g2', kind: 'final' }),
    { cancel: true, reason: 'group-no-mention-silence' });
});
