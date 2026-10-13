import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenmaiDeliveryCard } from '../src/sourcing-result-card.js';

const base = { project_id: 'P1', company: '示例', role: '开发', search_round: 2,
  search_brief: '上海 Java；联系 13800138000', excluded_candidate_refs_json: '["PT1","PT1","PL2"]' };
test('寻访结果卡使用冻结条件、真实轮次与去重排除数，并隐藏联系方式', () => {
  const card = buildOpenmaiDeliveryCard({ job: base, status: 'done', resultText: 'NO_REPLY',
    source: 'supermai', publicBaseUrl: 'https://base.yorkteam.cn' });
  const text = JSON.stringify(card);
  assert.match(text, /SuperMai/);
  assert.match(text, /续搜 · 已排除 2 人/);
  assert.match(text, /本轮条件：上海 Java/);
  assert.doesNotMatch(text, /13800138000|NO_REPLY/);
  assert.match(card.header.title.content, /未搜到/);
});
test('历史排除字段缺失或损坏不得虚构零人，自由找人缺链接不渲染空按钮', () => {
  const resultText = '<!-- BRAINX_CANDIDATES_V1\n'
    + JSON.stringify({ candidates: [{ candidate_ref: 'PT1234567890', name: '测试人' }] }) + '\n-->';
  for (const raw of [undefined, 'bad', '{}']) {
    const card = buildOpenmaiDeliveryCard({ job: { ...base, freeform: true,
      excluded_candidate_refs_json: raw }, status: 'done', resultText,
    publicBaseUrl: 'https://base.yorkteam.cn' });
    assert.match(JSON.stringify(card), /排除人数未记录/);
    const nodes = [];
    const visit = (value) => {
      if (value && typeof value === 'object') {
        if (value.tag === 'button') nodes.push(value);
        Object.values(value).forEach(visit);
      }
    };
    visit(card);
    assert.ok(nodes.every(button => button.multi_url || button.value));
  }
});
