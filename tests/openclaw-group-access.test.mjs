import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenClawGroupAccess } from '../src/openclaw-group-access.js';

test('动态项目群按读改写追加到 OpenClaw allowlist，重复执行幂等', async () => {
  let groups = ['oc_existing'];
  const calls = [];
  const access = createOpenClawGroupAccess({ cli: { call: async (args) => {
    calls.push(args);
    if (args[1] === 'get') return { stdout: JSON.stringify(groups) };
    groups = JSON.parse(args[3]);
    return { stdout: '' };
  } } });
  const first = await access.ensure('oc_project');
  const second = await access.ensure('oc_project');
  assert.deepEqual(first, { chat_id: 'oc_project', added: true, count: 2 });
  assert.deepEqual(second, { chat_id: 'oc_project', added: false, count: 2 });
  assert.deepEqual(groups, ['oc_existing', 'oc_project']);
  assert.deepEqual(calls[1].slice(0, 3), ['config', 'set', 'channels.feishu.groupAllowFrom']);
  assert.ok(calls[1].includes('--strict-json'));
});

test('并发追加串行化，不丢任何项目群；非法群和坏配置失败关闭', async () => {
  let groups = [];
  const access = createOpenClawGroupAccess({ cli: { call: async (args) => {
    if (args[1] === 'get') return { stdout: JSON.stringify(groups) };
    groups = JSON.parse(args[3]);
    return { stdout: '' };
  } } });
  await Promise.all([access.ensure('oc_a'), access.ensure('oc_b')]);
  assert.deepEqual(groups, ['oc_a', 'oc_b']);
  await assert.rejects(access.ensure('bad'), /OPENCLAW_GROUP_ID_INVALID/);
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
