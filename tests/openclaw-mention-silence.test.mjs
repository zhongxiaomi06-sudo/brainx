import assert from 'node:assert/strict';
import test from 'node:test';

import { createMentionSilenceHandler } from '../plugins/brainx-openclaw/mention-silence.js';

const GROUP_KEY = 'agent:feishu-mia-x:feishu:group:oc_g1';
const P2P_KEY = 'agent:feishu-mia-x:feishu:mia:direct:ou_u1';

function make() {
  let clock = 1_000_000;
  const handler = createMentionSilenceHandler({ now: () => clock });
  return { handler, advance: (ms) => { clock += ms; } };
}

test('群内没有 @ 的闲聊被吞掉，@ 消息照常', () => {
  const { handler } = make();
  assert.deepEqual(
    handler({ cleanedBody: '推人选的时候，要不然叫Reloop' }, { sessionKey: GROUP_KEY }),
    { handled: true, reason: 'group-no-mention-silence' });
  assert.equal(handler({ cleanedBody: '<at user_id="ou_bot"></at> 今天先做什么' }, { sessionKey: GROUP_KEY }), undefined);
});

test('按钮命令（标记或工具指令）、控制命令、找人条件放行', () => {
  const { handler } = make();
  for (const body of [
    '[BRAINTEX_SEARCH_START] 为项目 J1 使用 OpenMai 继续找人。',
    '[BRAINTEX_CANDIDATE_KEEP] 职位 J1 候选人 c-1',
    '把项目 J1 的候选人 c-1 标记为重点关注。现在调用 brainx_candidate_workflow',
    '为当前群绑定一个职位。先调用 brainx_bind_group_project',
    '/brainx',
    '找人条件：北京、半导体、总监',
  ]) {
    assert.equal(handler({ cleanedBody: body }, { sessionKey: GROUP_KEY }), undefined, body);
  }
});

test('可见动作后的 10 分钟内追问放行，超过窗口继续沉默', () => {
  const { handler, advance } = make();
  assert.equal(handler({ cleanedBody: '<at user_id="ou_bot"></at> 帮我接 J1' }, { sessionKey: GROUP_KEY }), undefined);
  advance(3 * 60 * 1000);
  assert.equal(handler({ cleanedBody: '确认，就是这个' }, { sessionKey: GROUP_KEY }), undefined,
    '10 分钟窗口内的会话追问不能掐断');
  advance(11 * 60 * 1000);
  assert.deepEqual(handler({ cleanedBody: '大家中午吃啥' }, { sessionKey: GROUP_KEY }),
    { handled: true, reason: 'group-no-mention-silence' });
});

test('私聊不适用沉默纪律', () => {
  const { handler } = make();
  assert.equal(handler({ cleanedBody: '在吗' }, { sessionKey: P2P_KEY }), undefined);
});
