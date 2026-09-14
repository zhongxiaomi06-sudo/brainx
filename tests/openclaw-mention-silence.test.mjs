import assert from 'node:assert/strict';
import test from 'node:test';

import { createMentionSilenceHandler } from '../plugins/brainx-openclaw/mention-silence.js';

const GROUP_CHAT = 'oc_g1';
const GROUP_SESSION = `agent:feishu-mia-x:feishu:group:${GROUP_CHAT}`;

function make() {
  let clock = 1_000_000;
  const silence = createMentionSilenceHandler({ now: () => clock });
  return { silence, advance: (ms) => { clock += ms; } };
}

const claim = (silence, event) => silence.onInboundClaim({
  channel: 'feishu', isGroup: true, sessionKey: GROUP_SESSION, ...event,
});

test('群内没有 @ 的闲聊被吞掉；@ 机器人（wasMentioned 原生判定）放行', () => {
  const { silence } = make();
  assert.deepEqual(claim(silence, { content: '推人选的时候，要不然叫Reloop', wasMentioned: false }),
    { handled: true });
  assert.equal(claim(silence, { content: '在吗，回复我一下', wasMentioned: true }), undefined);
});

test('@ 别人（wasMentioned=false 且无命令特征）同样吞掉', () => {
  const { silence } = make();
  assert.deepEqual(claim(silence, { content: '<at user_id="ou_someone">@Mia</at> 吃饭吗', wasMentioned: false }),
    { handled: true });
});

test('按钮命令（标记或工具指令）、控制命令放行；「找人条件」吞掉（静默登记）', () => {
  const { silence } = make();
  for (const body of [
    '[BRAINTEX_SEARCH_START] 为项目 J1 使用 OpenMai 继续找人。',
    '[BRAINTEX_CANDIDATE_KEEP] 职位 J1 候选人 c-1',
    '把项目 J1 的候选人 c-1 标记为重点关注。现在调用 brainx_candidate_workflow',
    '为当前群绑定一个职位。先调用 brainx_bind_group_project',
    '/brainx',
  ]) {
    assert.equal(claim(silence, { content: body, wasMentioned: false }), undefined, body);
  }
  assert.deepEqual(claim(silence, { content: '找人条件：北京、半导体、总监', wasMentioned: false }),
    { handled: true });
});

test('可见动作后的 10 分钟内追问放行，超过窗口恢复沉默', () => {
  const { silence, advance } = make();
  assert.equal(claim(silence, { content: '帮我接 J1', wasMentioned: true }), undefined);
  advance(3 * 60 * 1000);
  assert.equal(claim(silence, { content: '确认，就是这个', wasMentioned: false }), undefined,
    '10 分钟窗口内的会话追问不能掐断');
  advance(11 * 60 * 1000);
  assert.deepEqual(claim(silence, { content: '大家中午吃啥', wasMentioned: false }), { handled: true });
});

test('私聊与非飞书渠道不适用沉默纪律', () => {
  const { silence } = make();
  assert.equal(silence.onInboundClaim({
    channel: 'feishu', isGroup: false, sessionKey: 'agent:x:feishu:mia:direct:ou_u1', content: '在吗',
  }), undefined);
  assert.equal(silence.onInboundClaim({
    channel: 'telegram', isGroup: true, sessionKey: GROUP_SESSION, content: 'hello',
  }), undefined);
});
