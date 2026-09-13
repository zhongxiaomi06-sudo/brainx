import assert from 'node:assert/strict';
import test from 'node:test';

import { createMentionSilenceHandler } from '../plugins/brainx-openclaw/mention-silence.js';

const GROUP_KEY = 'agent:feishu-mia-x:feishu:group:oc_g1';
const P2P_KEY = 'agent:feishu-mia-x:feishu:mia:direct:ou_u1';

function make() {
  let clock = 1_000_000;
  const silence = createMentionSilenceHandler({ now: () => clock });
  return { silence, advance: (ms) => { clock += ms; } };
}

test('群内没有 @ 的闲聊回复被取消，@ 消息的回复照常', () => {
  const { silence } = make();
  silence.onMessageReceived({ content: '推人选的时候，要不然叫Reloop', sessionKey: GROUP_KEY });
  assert.deepEqual(
    silence.onReplySending({ sessionKey: GROUP_KEY, kind: 'final' }),
    { cancel: true, reason: 'group-no-mention-silence' });
  silence.onMessageReceived({ content: '<at user_id="ou_bot"></at> 今天先做什么', sessionKey: GROUP_KEY });
  assert.equal(silence.onReplySending({ sessionKey: GROUP_KEY, kind: 'final' }), undefined);
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
    silence.onMessageReceived({ content: body, sessionKey: GROUP_KEY });
    assert.equal(silence.onReplySending({ sessionKey: GROUP_KEY, kind: 'final' }), undefined, body);
  }
});

test('可见动作后的 10 分钟内追问放行，超过窗口恢复沉默', () => {
  const { silence, advance } = make();
  silence.onMessageReceived({ content: '<at user_id="ou_bot"></at> 帮我接 J1', sessionKey: GROUP_KEY });
  advance(3 * 60 * 1000);
  silence.onMessageReceived({ content: '确认，就是这个', sessionKey: GROUP_KEY });
  assert.equal(silence.onReplySending({ sessionKey: GROUP_KEY, kind: 'final' }), undefined,
    '10 分钟窗口内的会话追问不能掐断');
  advance(11 * 60 * 1000);
  silence.onMessageReceived({ content: '大家中午吃啥', sessionKey: GROUP_KEY });
  assert.deepEqual(silence.onReplySending({ sessionKey: GROUP_KEY, kind: 'final' }),
    { cancel: true, reason: 'group-no-mention-silence' });
});

test('私聊不适用沉默纪律；无入站记录 fail-open 不错杀', () => {
  const { silence } = make();
  silence.onMessageReceived({ content: '在吗', sessionKey: P2P_KEY });
  assert.equal(silence.onReplySending({ sessionKey: P2P_KEY, kind: 'final' }), undefined);
  assert.equal(silence.onReplySending({ sessionKey: GROUP_KEY, kind: 'final' }), undefined,
    '进程重启丢入站记录时宁可放过');
});
