import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestSearchRelaxation, relaxedSearchElements } from '../src/search-relaxation.js';
import { parseSearchStartNotice } from '../plugins/brainx-openclaw/search-start-notice.js';
test('仅明确软偏好可建议取消，硬条件与未标注条件保留', () => {
  const out = suggestSearchRelaxation('上海算法工程师；必须三年以上经验；优先机器人行业；最好知名公司');
  assert.deepEqual(out.removed, ['优先机器人行业', '最好知名公司']);
  assert.match(out.criteria, /^上海算法工程师；必须三年以上经验/);
  assert.equal(suggestSearchRelaxation('上海算法工程师；必须机器人行业'), null);
  assert.equal(suggestSearchRelaxation('上海算法工程师；优先北京且必须五年经验'), null);
  assert.equal(suggestSearchRelaxation('优先机器人行业'), null);
  assert.equal(suggestSearchRelaxation('联系13812345678；优先机器人行业'), null);
});
test('放宽按钮有确认且固定渠道/职位，不会在渲染时搜索', () => {
  const elements = relaxedSearchElements({ project_id: 'P1', search_brief: '上海算法工程师；优先机器人行业' });
  const button = elements[1].columns.flatMap(c => c.elements).find(e => e.tag === 'button');
  assert.match(button.confirm.text.content, /可能计费/);
  const action = parseSearchStartNotice(button.value.text);
  assert.equal(action.projectRef, 'P1'); assert.equal(action.entry, 'OpenMai'); assert.equal(action.continuing, true);
  assert.match(action.criteria, /其余条件保持不变/);
  const free = relaxedSearchElements({ freeform: true, criteria: '上海算法工程师；优先机器人行业' });
  const freeButton = free[1].columns.flatMap(c => c.elements).find(e => e.tag === 'button');
  assert.match(freeButton.confirm.text.content, /不继承/);
  assert.equal(parseSearchStartNotice(freeButton.value.text).continuing, false);
  assert.equal(parseSearchStartNotice('[BRAINTEX_PROJECT_START] {"job_id":"other","entry":"curl","criteria":"abcde","continue_search":true}'), null);
});
