import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoSearchCriteria, cleanPipeline } from '../src/auto-search.js';

test('cleanPipeline 去掉 TTC 漏斗计数（审查实证样本）', () => {
  // 生产真实样本：全为漏斗计数 → 应返回 null
  assert.equal(cleanPipeline('Interview×38 Offer×1 Onboarding×2 Recommendation×106 Sourcing×37'), null);
  assert.equal(cleanPipeline('Interview×18 Offer×1 Recommendation×66 Sourcing×7'), null);
  assert.equal(cleanPipeline('Interview×4 Recommendation×7 Sourcing×2'), null);
  assert.equal(cleanPipeline('Recommendation×1'), null);
});

test('cleanPipeline 保留真实业务描述，只剥离计数片段', () => {
  assert.equal(cleanPipeline('AI 大模型应用 Interview×3'), 'AI 大模型应用');
  assert.equal(cleanPipeline('社交推荐算法 Offer×2 内容生态'), '社交推荐算法 内容生态');
});

test('cleanPipeline 处理空/null 字符串', () => {
  assert.equal(cleanPipeline(null), null);
  assert.equal(cleanPipeline(''), null);
  assert.equal(cleanPipeline('null'), null);
  assert.equal(cleanPipeline('NULL'), null);
  assert.equal(cleanPipeline('   '), null);
});

test('buildAutoSearchCriteria 判据不含漏斗噪声（回归点 sm_bafc5d0f）', () => {
  const job = {
    role: 'Java后端开发工程师', city: '深圳市', hc: 1,
    company: '上海随便找个信息科技有限公司',
    pipeline: 'Interview×18 Offer×1 Recommendation×66 Sourcing×7',
  };
  const c = buildAutoSearchCriteria(job);
  assert.equal(c, 'Java后端开发工程师，深圳市，1人，上海随便找个信息科技有限公司背景，3-5 年工作经验');
  assert.ok(!/Interview×|Offer×|Recommendation×|Sourcing×/.test(c), '判据不得含漏斗计数');
});

test('buildAutoSearchCriteria 保留真实 pipeline 业务描述', () => {
  const job = {
    role: 'AI 大模型工程师', city: '北京', hc: 2,
    company: '某某科技', pipeline: '大模型推理优化 Interview×3',
  };
  const c = buildAutoSearchCriteria(job);
  assert.ok(c.includes('主要做大模型推理优化'), '应保留业务描述');
  assert.ok(!/Interview×/.test(c), '应剥离计数');
});

test('buildAutoSearchCriteria 缺 role 与 company 返回 null', () => {
  assert.equal(buildAutoSearchCriteria(null), null);
  assert.equal(buildAutoSearchCriteria({ city: '北京' }), null);
});
