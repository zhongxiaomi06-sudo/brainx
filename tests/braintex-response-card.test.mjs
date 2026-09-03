import assert from 'node:assert/strict';
import test from 'node:test';
import { formatBrainxReplyPayload } from '../plugins/brainx-openclaw/response-card.js';

test('飞书最终文字回答统一转成有标题、分段和工作台入口的卡片', () => {
  const result = formatBrainxReplyPayload({
    kind: 'final', channel: 'feishu', payload: {
      text: '## 建议接单\n依据：HC 充足。\n\n## 风险\n负责人尚未确认。\n\n## 下一步\n确认后启动找人。',
    },
  }, { publicBaseUrl: 'https://brainx.example.com' });
  assert.equal(result.payload.presentation.title, 'BrainTex · 职位决策');
  assert.ok(result.payload.presentation.blocks.filter(({ type }) => type === 'text').length >= 3);
  const buttons = result.payload.presentation.blocks.find(({ type }) => type === 'buttons').buttons;
  assert.equal(buttons[0].url, 'https://brainx.example.com/');
  assert.match(result.payload.text, /建议接单/);
});

test('不重复包装已有卡片，也不包装工具过程和非飞书回答', () => {
  const base = { kind: 'final', channel: 'feishu', payload: { text: '内容' } };
  assert.equal(formatBrainxReplyPayload({ ...base, payload: { ...base.payload, presentation: { blocks: [] } } }), undefined);
  assert.equal(formatBrainxReplyPayload({ ...base, kind: 'tool' }), undefined);
  assert.equal(formatBrainxReplyPayload({ ...base, channel: 'webchat' }), undefined);
  assert.equal(formatBrainxReplyPayload({ ...base, payload: { ...base.payload, isCommentary: true } }), undefined);
});
