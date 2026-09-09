import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBrainxReplyPayload } from '../plugins/brainx-openclaw/response-card.js';

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

test('职位推荐被整理为逐职位分析和可执行按钮，不再只是长 Markdown', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: { text: `**今日职位推荐验收卡**
数据来源：BrainX 最近一轮真实推荐，整体置信度偏低。

1. **上海它石智航｜机器人 SLAM 算法工程师｜\`JTQTOTR\`**
**结论：** 值得优先核验。
**关键依据：** 推荐分 93.1；HC 2；方向匹配 100。
**主要风险：** 招聘状态缺失；连续三轮未互动。
**下一步：** 先联系 owner 确认当前阶段。

2. **大疆｜飞控算法工程师｜\`JFZVW7R\`**
**结论：** 值得核验，但不能直接冲。
**关键依据：** 推荐分 93.1；HC 3。
**主要风险：** 职位事实已超过 30 天。
**下一步：** 确认仍开放后再找人。` },
  }, { publicBaseUrl: 'https://brainx.example.com/app?unsafe=1' });

  assert.equal(result.payload.presentation.title, 'BrainTex · 今日职位推荐');
  const texts = result.payload.presentation.blocks.filter(({ type }) => type === 'text');
  assert.match(texts[1].text, /上海它石智航｜机器人 SLAM 算法工程师/);
  assert.match(texts[1].text, /招聘状态缺失/);
  const buttonGroups = result.payload.presentation.blocks.filter(({ type }) => type === 'buttons');
  assert.equal(buttonGroups[0].buttons[0].label, '查看职位');
  assert.equal(buttonGroups[0].buttons[0].url, 'https://brainx.example.com/?open=opportunity%3AJTQTOTR');
  assert.equal(buttonGroups[0].buttons[1].label, '联系人与推进');
  assert.match(buttonGroups[0].buttons[1].action.command, /职位 JTQTOTR/);
  assert.match(buttonGroups[0].buttons[1].action.command, /明确确认/);
  assert.equal(buttonGroups.at(-1).buttons[0].label, '调整每日推荐');
});

test('模型使用公司职位分行格式时仍生成逐职位按钮', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: { text: `1. **公司：** 上海它石智航技术有限公司
**职位：** 机器人SLAM算法工程师
**职位ID：** \`JTQTOTR\`
**结论：** 值得优先核验。
**关键依据：** 推荐分 93.1；HC 2。
**主要风险：** 招聘状态缺失。
**下一步：** 先确认当前阶段。` },
  }, { publicBaseUrl: 'https://brainx.example.com' });

  const buttonGroups = result.payload.presentation.blocks.filter(({ type }) => type === 'buttons');
  assert.equal(buttonGroups[0].buttons[0].url, 'https://brainx.example.com/?open=opportunity%3AJTQTOTR');
  assert.equal(buttonGroups[0].buttons[1].label, '联系人与推进');
});

test('TTC 候选结果清除转义乱码并改为行内人才库按钮', () => {
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
  const rows = card.body.elements.filter((element) => element.tag === 'column_set');
  assert.equal(rows.length, 3, '一行表头加两行候选人');
  assert.equal(rows[1].columns[0].elements[0].text.content, '张三\n百度 / 测试开发');
  const firstButton = rows[1].columns.at(-1).elements[0];
  assert.equal(firstButton.text.content, '查看人才');
  assert.equal(firstButton.behaviors[0].default_url, 'https://app.ttcadvisory.com/app/talent/PL123');
  assert.equal(rows[2].columns.at(-1).elements[0].behaviors[0].default_url,
    'https://app.ttcadvisory.com/app/talent/PL456');
  assert.doesNotMatch(JSON.stringify(result.payload), /"content":"发送简历"|brainx_send_candidate_resume|&#x20;|\\\||\\##/);
  assert.match(result.payload.text, /张三.*PL123/s);
});

test('候选表格不把第三方或无效链接包装成 TTC 按钮', () => {
  const text = `候选人结果\n| 姓名 | 当前公司 / 职位 | 匹配度 | 详情 |\n|---|---|---|---|\n| 张三 | 甲公司 / 测试开发 | 80% | [查看](https://evil.example/talent/PL123) |`;
  const result = formatBrainxReplyPayload({ kind: 'final', channel: 'feishu', payload: { text } });
  const rows = result.payload.channelData.feishu.card.body.elements
    .filter((element) => element.tag === 'column_set');
  assert.equal(rows[1].columns.at(-1).elements[0].text.content, '链接待核实');
  assert.doesNotMatch(JSON.stringify(result.payload), /evil\.example/);
});
