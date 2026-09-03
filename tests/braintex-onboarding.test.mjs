import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBraintexHomeCommand,
  createBraintexHomePresentation,
} from '../plugins/brainx-openclaw/onboarding.js';

test('BrainTex 首页覆盖顾问核心工作入口和推荐设置', () => {
  const presentation = createBraintexHomePresentation({ publicBaseUrl: 'https://brainx.example.com/' });
  assert.equal(presentation.title, 'BrainTex · 你的 AI 猎头助手');
  const buttons = presentation.blocks.flatMap((block) => block.type === 'buttons' ? block.buttons : []);
  const labels = buttons.map(({ label }) => label);
  assert.deepEqual(labels.slice(0, 6), [
    '今天先做什么', '推荐值得做的职位', '为职位找候选人',
    '判断一个职位', '看跟进建议', '生成个人复盘',
  ]);
  assert.deepEqual(labels.slice(6, 8), ['设置每日推荐', '切换我的模型']);
  assert.equal(buttons.at(-1).url, 'https://brainx.example.com/');
  for (const button of buttons.slice(0, 8)) {
    assert.equal(button.action.type, 'command');
    assert.ok(button.action.command === '/model' || button.action.command.length > 20);
    assert.doesNotMatch(button.action.command, /ou_|oc_|@|1[3-9]\d{9}/);
  }
});

test('BrainTex 首页不把本地或危险地址作为工作台链接', () => {
  for (const publicBaseUrl of ['http://127.0.0.1:3000', 'javascript:alert(1)', 'not-a-url']) {
    const presentation = createBraintexHomePresentation({ publicBaseUrl });
    const buttons = presentation.blocks.flatMap((block) => block.type === 'buttons' ? block.buttons : []);
    assert.equal(buttons.some(({ url }) => Boolean(url)), false);
  }
});

test('BrainTex /brainx 命令不调用模型，未授权时拒绝', async () => {
  const command = createBraintexHomeCommand({ publicBaseUrl: '' });
  assert.equal(command.name, 'brainx');
  assert.equal(command.requireAuth, true);
  const allowed = await command.handler({ channel: 'feishu', isAuthorizedSender: true });
  assert.equal(allowed.presentation.blocks.some(({ type }) => type === 'buttons'), true);
  const denied = await command.handler({ channel: 'feishu', isAuthorizedSender: false });
  assert.equal(denied.isError, true);
  assert.equal(denied.presentation, undefined);
});
