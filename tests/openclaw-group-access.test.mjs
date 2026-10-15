import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawGroupAccess } from '../src/openclaw-group-access.js';

test('动态项目群按读改写追加到 OpenClaw allowlist，重复执行幂等', async () => {
  let groups = ['oc_existing'];
  let senders = ['ou_existing'];
  const calls = [];
  let mentionSet = false;
  const access = createOpenClawGroupAccess({ cli: { call: async (args) => {
    calls.push(args);
    const path = String(args[2] || '');
    // mention 门：set 之前路径不存在（CLI exit 1），set 之后返 'false'（幂等跳过）
    if (args[1] === 'get' && path.endsWith('.requireMention')) {
      if (!mentionSet) throw Object.assign(new Error('Config path not found'), { code: 'OPENCLAW_COMMAND_FAILED' });
      return { stdout: 'false' };
    }
    if (args[1] === 'get') return { stdout: JSON.stringify(path.includes('Sender') ? senders : groups) };
    if (path.endsWith('.requireMention')) { mentionSet = true; return { stdout: '' }; }
    if (path.includes('Sender')) senders = JSON.parse(args[3]);
    else if (path === 'channels.feishu.groupAllowFrom') groups = JSON.parse(args[3]);
    return { stdout: '' };
  } } });
  const first = await access.ensure('oc_project', ['ou_owner', 'ou_partner']);
  const second = await access.ensure('oc_project', ['ou_owner', 'ou_partner']);
  assert.deepEqual(first, { chat_id: 'oc_project', added: true, count: 2,
    sender_added: 2, sender_count: 3, card_actions_enabled: true });
  assert.deepEqual(second, { chat_id: 'oc_project', added: false, count: 2,
    sender_added: 0, sender_count: 3, card_actions_enabled: true });
  assert.deepEqual(groups, ['oc_existing', 'oc_project']);
  assert.deepEqual(senders, ['ou_existing', 'ou_owner', 'ou_partner']);
  assert.deepEqual(calls[1].slice(0, 3), ['config', 'set', 'channels.feishu.groupAllowFrom']);
  assert.ok(calls[1].includes('--strict-json'));
  assert.deepEqual(calls.find((args) => args[1] === 'set' && args[2]?.endsWith('.requireMention'))?.slice(1), [
    'set', 'channels.feishu.groups.oc_project.requireMention', 'false', '--strict-json',
  ]);
});

test('requireMention 已为 false 的群不再重写（重写会 bump meta.lastTouchedAt 触发 openclaw 全量 reload，打死在途 turn）', async () => {
  let groups = ['oc_warm'];
  let senders = ['ou_owner'];
  const calls = [];
  const access = createOpenClawGroupAccess({ cli: { call: async (args) => {
    calls.push(args);
    const path = String(args[2] || '');
    if (args[1] === 'get' && path.endsWith('.requireMention')) return { stdout: 'false' };
    if (args[1] === 'get') return { stdout: JSON.stringify(path.includes('Sender') ? senders : groups) };
    return { stdout: '' };
  } } });
  const first = await access.ensure('oc_warm', ['ou_owner']);
  const second = await access.ensure('oc_warm', ['ou_owner']);
  assert.equal(first.added, false);
  assert.equal(second.added, false);
  const mentionCalls = calls.filter((args) => String(args[2] || '').endsWith('.requireMention'));
  assert.equal(mentionCalls.length, 2, '两次 ensure 各一次 get（已是 false 不写）');
  assert.ok(mentionCalls.every((args) => args[1] === 'get'), '全是 get，零 set');
  assert.ok(!calls.some((args) => args[1] === 'set' && String(args[2] || '').endsWith('.requireMention')),
    'requireMention 已 false 时零次 set = 零次 reload = 不再打死在途 turn');
});

test('并发追加串行化，不丢任何项目群；非法群和坏配置失败关闭', async () => {
  let groups = [];
  let senders = [];
  const access = createOpenClawGroupAccess({ cli: { call: async (args) => {
    if (args[1] === 'get') return { stdout: JSON.stringify(args[2].includes('Sender') ? senders : groups) };
    if (args[2].includes('Sender')) senders = JSON.parse(args[3]);
    else if (args[2] === 'channels.feishu.groupAllowFrom') groups = JSON.parse(args[3]);
    return { stdout: '' };
  } } });
  await Promise.all([access.ensure('oc_a', ['ou_a']), access.ensure('oc_b', ['ou_b'])]);
  assert.deepEqual(groups, ['oc_a', 'oc_b']);
  assert.deepEqual(senders, ['ou_a', 'ou_b']);
  await assert.rejects(access.ensure('bad'), /OPENCLAW_GROUP_ID_INVALID/);
  await assert.rejects(access.ensure('oc_ok', ['bad']), /OPENCLAW_GROUP_SENDER_INVALID/);
  const broken = createOpenClawGroupAccess({ cli: { call: async () => ({ stdout: '{}' }) } });
  await assert.rejects(broken.ensure('oc_ok'), /OPENCLAW_GROUP_CONFIG_INVALID/);
});

test('OpenClaw 命令失败返回稳定错误码，不泄露命令输出', async () => {
  const access = createOpenClawGroupAccess({ cli: { call: async () => {
    throw new Error('secret command output');
  } } });
  await assert.rejects(access.ensure('oc_project'),
    (error) => error.code === 'OPENCLAW_GROUP_ALLOWLIST_FAILED'
      && !error.message.includes('secret command output'));
});
