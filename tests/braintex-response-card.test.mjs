import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBrainxReplyPayload } from '../plugins/brainx-openclaw/response-card.js';
import { createRichReplySendingHandler } from '../plugins/brainx-openclaw/rich-reply-sending.js';

test('飞书最终文字回答统一转成有标题、分段和工作台入口的卡片', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: {
      text: '## 建议接单\n依据：HC 充足。\n\n## 风险\n负责人尚未确认。\n\n## 下一步\n确认后启动找人。',
    },
  }, { publicBaseUrl: 'https://brainx.example.com' });
  assert.equal(result.payload.presentation.title, 'BrainTex · 今日职位推荐');
  assert.ok(result.payload.presentation.blocks.filter(({ type }) => type === 'text').length >= 3);
  const buttons = result.payload.presentation.blocks.find(({ type }) => type === 'buttons').buttons;
  assert.equal(buttons[0].url, 'https://brainx.example.com/');
  assert.match(result.payload.text, /建议接单/);
});

test('保留已有互动卡片，也不包装工具过程和非飞书回答', () => {
  const base = { kind: 'final', channel: 'feishu', payload: { text: '内容' } };
  assert.equal(formatBrainxReplyPayload({
    ...base,
    payload: { ...base.payload, presentation: { blocks: [{ type: 'buttons', buttons: [] }] } },
  }), undefined);
  assert.equal(formatBrainxReplyPayload({ ...base, kind: 'tool' }), undefined);
  assert.equal(formatBrainxReplyPayload({ ...base, channel: 'webchat' }), undefined);
  assert.equal(formatBrainxReplyPayload({ ...base, payload: { ...base.payload, isCommentary: true } }), undefined);
});

test('真实投递省略事件渠道时从 hook 上下文识别 Feishu', () => {
  const result = formatBrainxReplyPayload({ kind: 'final', payload: { text: '职位建议：先核验。' } }, {
    channelId: 'feishu', publicBaseUrl: 'https://brainx.example.com',
  });
  assert.equal(result.payload.presentation.title, 'BrainTex · 今日职位推荐');
});

test('职位推荐被整理为稳定的三段摘要和可执行按钮，不再只是长 Markdown', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: { text: `**今日职位推荐验收卡**
数据来源：BrainX 最近一轮真实推荐，整体置信度偏低。

1. **上海它石智航｜机器人 SLAM 算法工程师｜\`JTQTOTR\`**
**职位简介：** 机器人定位与运动规划岗位，HC 2。
**适合原因：** SLAM 方向与我的机器人算法画像一致。
**需要确认：** 招聘状态缺失；连续三轮未互动。

2. **大疆｜飞控算法工程师｜\`JFZVW7R\`**
**职位简介：** 飞控算法岗位，HC 3。
**适合原因：** 控制算法方向与我的画像一致。
**需要确认：** 职位事实已超过 30 天。` },
  }, { publicBaseUrl: 'https://brainx.example.com/app?unsafe=1' });

  assert.equal(result.payload.presentation.title, 'BrainTex · 今日职位推荐');
  const texts = result.payload.presentation.blocks.filter(({ type }) => type === 'text');
  assert.match(texts[1].text, /上海它石智航｜机器人 SLAM 算法工程师/);
  assert.match(texts[1].text, /职位简介.*机器人定位与运动规划岗位/);
  assert.match(texts[1].text, /适合原因.*SLAM 方向/);
  assert.doesNotMatch(texts[1].text, /推荐分 93\.1/);
  assert.match(texts[1].text, /招聘状态缺失/);
  const buttonGroups = result.payload.presentation.blocks.filter(({ type }) => type === 'buttons');
  assert.equal(buttonGroups[0].buttons[0].label, '查看职位');
  assert.equal(buttonGroups[0].buttons[0].url, 'https://brainx.example.com/?open=opportunity%3AJTQTOTR');
  assert.equal(buttonGroups[0].buttons[1].label, '接单并建群');
  assert.match(buttonGroups[0].buttons[1].action.command, /brainx_accept_job/);
  assert.match(buttonGroups[0].buttons[1].action.command, /不要再次询问/);
  assert.equal(buttonGroups[0].buttons[2].label, '联系人与推进');
  assert.equal(buttonGroups.at(-1).buttons[0].label, '调整每日推荐');
});

test('模型使用公司职位分行格式时仍生成逐职位按钮', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: { text: `1. **公司：** 上海它石智航技术有限公司
**职位：** 机器人SLAM算法工程师
**职位ID：** \`JTQTOTR\`
**职位简介：** 机器人定位与运动规划岗位，HC 2。
**适合原因：** SLAM 方向与我的画像一致。
**需要确认：** 招聘状态缺失。` },
  }, { publicBaseUrl: 'https://brainx.example.com' });

  const buttonGroups = result.payload.presentation.blocks.filter(({ type }) => type === 'buttons');
  assert.equal(buttonGroups[0].buttons[0].url, 'https://brainx.example.com/?open=opportunity%3AJTQTOTR');
  assert.equal(buttonGroups[0].buttons[1].label, '接单并建群');
  assert.equal(buttonGroups[0].buttons[2].label, '联系人与推进');
});

test('旧版职位字段仍能归一化为新的三段摘要', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: { text: `1. 甲公司｜算法工程师｜P12345
结论：负责机器人控制算法
关键依据：方向画像命中运动控制
主要风险：工作地点待确认
下一步：联系负责人` },
  });
  const text = result.payload.presentation.blocks.find(({ type }) => type === 'text').text;
  assert.match(text, /职位简介.*负责机器人控制算法/);
  assert.match(text, /适合原因.*方向画像命中运动控制/);
  assert.match(text, /需要确认.*工作地点待确认/);
  assert.doesNotMatch(text, /下一步|联系负责人/);
});

test('TTC 候选结果清除转义乱码并为每人提供查看、初筛通过和演示收藏', () => {
  const text = String.raw`TTC 测试客户 · 测试开发
\
\## 搜索结果
\
已先搜索我的人才库，随后搜索 TTC 公域人才库。
\
\### 条件分类
\
\- 底线条件：Python、测试开发、5–8 年。
\
\### 推荐候选人
\
\| # | 姓名 | 当前公司 / 职位 | 经验 | 城市 | 学历 / 院校 | 核心匹配点 | 匹配度 | 详情 |
\|---|---|---|---|---|---|---|---|---|
\| 1 | 张三 | 百度 / 测试开发 | 7 年 | 北京 | 硕士 / 211 | Python、自动化测试 | 86% | [查看](https://app.ttcadvisory.com/app/talent/PL123) |
\| 2 | 李四 | 京东 / 测试开发 | 5 年 | 北京 | 本科 / 985 | 电商测试平台 | 84% | [查看](https://brainx.example.com/?candidate=PL456) |`;
  const result = formatBrainxReplyPayload({ kind: 'final', channel: 'feishu', payload: { text } });
  const card = result.payload.channelData.feishu.card;
  assert.equal(card.schema, '2.0');
  const summaries = card.body.elements.filter((element) => element.tag === 'markdown'
    && /\*\*.*｜.*\*\*/.test(element.content));
  assert.equal(summaries.length, 2, '每名候选人都有独立摘要');
  assert.match(summaries[0].content, /张三｜百度 \/ 测试开发/);
  const actions = card.body.elements.filter((element) => element.tag === 'button');
  assert.equal(actions.length, 6, '每名候选人紧跟三个顶层动作，避免被飞书清洗器丢弃');
  const firstActions = actions.slice(0, 3);
  assert.deepEqual(firstActions.map((button) => button.text.content), ['查看人才', '初筛通过', '收藏']);
  assert.equal(firstActions[0].behaviors[0].default_url, 'https://app.ttcadvisory.com/app/talent/PL123');
  assert.deepEqual(Object.keys(firstActions[1].behaviors[0].value).sort(), ['a', 'k', 'oc', 'q']);
  assert.equal(firstActions[1].behaviors[0].value.oc, 'ocf1');
  assert.match(firstActions[1].behaviors[0].value.q, /candidate_ref=PL123/);
  assert.match(firstActions[1].behaviors[0].value.q, /action=KEEP_FOR_REVIEW/);
  assert.match(firstActions[2].behaviors[0].value.q, /不要调用任何工具/);
  assert.doesNotMatch(firstActions[2].behaviors[0].value.q, /brainx_/);
  assert.equal(actions[3].behaviors[0].default_url, 'https://app.ttcadvisory.com/app/talent/PL456');
  assert.doesNotMatch(JSON.stringify(result.payload), /"content":"发送简历"|brainx_send_candidate_resume|&#x20;|\\\||\\##/);
  assert.match(result.payload.text, /张三.*PL123/s);
});

test('候选表格不把第三方或无效链接包装成 TTC 按钮', () => {
  const text = `候选人结果\n| 姓名 | 当前公司 / 职位 | 匹配度 | 详情 |\n|---|---|---|---|\n| 张三 | 甲公司 / 测试开发 | 80% | [查看](https://evil.example/talent/PL123) |`;
  const result = formatBrainxReplyPayload({ kind: 'final', channel: 'feishu', payload: { text } });
  const cardText = JSON.stringify(result.payload.channelData.feishu.card);
  assert.match(cardText, /链接待核实/);
  assert.doesNotMatch(cardText, /"tag":"button"/);
  assert.doesNotMatch(JSON.stringify(result.payload), /evil\.example/);
});

test('OpenClaw 最终发送钩子用飞书适配器投递推荐卡并取消原始纯文本', async () => {
  const sent = [];
  const handler = createRichReplySendingHandler({
    config: {},
    runtime: {
      config: { current: () => ({ channels: { feishu: {} } }) },
      channel: { outbound: { loadAdapter: async () => ({
        sendPayload: async (payload) => sent.push(payload),
      }) } },
    },
  });
  const content = `1. 测试公司｜算法工程师｜P292374
结论：建议核验
关键依据：匹配分 80
主要风险：HC 仅 1
下一步：接单`;
  const result = await handler({ to: 'ou_test', content }, {
    channelId: 'feishu', accountId: 'default',
  });
  assert.deepEqual(result, { cancel: true, cancelReason: 'brainx_rich_reply_sent' });
  assert.equal(sent.length, 1);
  const buttons = sent[0].payload.presentation.blocks.find(({ type }) => type === 'buttons').buttons;
  assert.equal(buttons[0].label, '接单并建群');
  assert.equal(sent[0].to, 'ou_test');
});

test('飞书替换卡投递失败时保留原始文字', async () => {
  const handler = createRichReplySendingHandler({
    runtime: { channel: { outbound: { loadAdapter: async () => ({
      sendPayload: async () => { throw new Error('offline'); },
    }) } } },
  });
  assert.equal(await handler({ to: 'ou_test', content: '职位建议：先核验。' }, {
    channelId: 'feishu',
  }), undefined);
});
