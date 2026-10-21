import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAutoSearchCriteria, cleanPipeline, sanitizeJdNotes,
  parseExperienceRange, jobNotesText } from '../src/auto-search.js';

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
  assert.equal(c, 'Java后端开发工程师，深圳市，1人，（招聘方：上海随便找个信息科技有限公司），3-5 年工作经验');
  assert.ok(!/Interview×|Offer×|Recommendation×|Sourcing×/.test(c), '判据不得含漏斗计数');
  assert.ok(!c.includes('背景'), 'spec 040：不再拼「X背景」（语义倒置）');
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

/* ---------- specs/040 S1 规则底座（§3 边界用例） ---------- */

// 用例 1：JWH6Q57 真实数据——3-8 年 + 30岁以内 + 忌讳大厂
test('S1-1 JD 真实年限生效 + 年龄条件剥离 + 客户禁忌保留（JWH6Q57）', () => {
  const job = {
    role: 'AI产品运营增长-toc', city: '北京市', hc: 1,
    company: '北京耳朵时间科技有限公司',
    notes: '3-8年工作经验【必须项】。0-1产品增长运营背景。目标公司不限，但忌讳仅有大厂经历。30岁以内优先。',
  };
  const c = buildAutoSearchCriteria(job);
  assert.ok(c.includes('3-8 年工作经验'), '年限段应为 JD 真实区间');
  assert.ok(!c.includes('30岁以内'), '年龄条件必须剥离');
  assert.ok(c.includes('忌讳仅有大厂经历'), '客户禁忌必须保留（felix 投诉核心丢失项）');
  assert.ok(c.includes('JD 原文要点：'), 'notes 分支真实执行（接线完备性断言）');
});

// 用例 2：J3ZJYBB 真实数据——销售向 JD 语义入判据
test('S1-2 销售向 JD 职责入判据（J3ZJYBB）', () => {
  const job = {
    role: '商业化运营/商务BD-广告主资源方向', city: '北京市、上海市', hc: 1,
    company: '上海天码形空科技有限公司（OiiOii）',
    notes: '独立开拓广告主客户资源，负责商务谈判、合同签订及回款跟进，完成销售指标。',
  };
  const c = buildAutoSearchCriteria(job);
  assert.ok(c.includes('开拓广告主客户'), '销售语义必须入判据');
  assert.ok(c.includes('商务谈判') && c.includes('销售指标'), '谈判/销售指标语义入判据');
});

// 用例 3：无 notes 无 jdText
test('S1-3 无 notes/jdText：无 JD 段，年限兜底 3-5 年', () => {
  const c = buildAutoSearchCriteria({ role: 'Java后端', city: '深圳', company: 'X公司' });
  assert.ok(!c.includes('JD 原文要点'), '无 notes 不得输出空段');
  assert.ok(c.includes('3-5 年工作经验'), '兜底年限');
});

// 用例 4：性别条件剥离
test('S1-4 性别条件剥离', () => {
  const c = buildAutoSearchCriteria({ role: '行政前台', city: '上海', company: 'X公司',
    notes: '负责访客接待。女生优先。' });
  assert.ok(!c.includes('女生') && !c.includes('男生'), '性别字样必须剥离');
  assert.ok(c.includes('访客接待'), '正常职责保留');
});

// 用例 5：超长 notes 截 500 字
test('S1-5 超长 notes 截 500 字', () => {
  const c = buildAutoSearchCriteria({ role: 'R', city: 'C', company: 'X',
    notes: '职'.repeat(3000) });
  assert.ok(c.includes('职'.repeat(500)), '保留满 500 字');
  assert.ok(!c.includes('职'.repeat(501)), 'notes 段不超 500 字');
});

// 用例 6：招聘方语义
test('S1-6 company 输出（招聘方：X），不再拼 X背景', () => {
  const c = buildAutoSearchCriteria({ role: '技术负责人', city: '北京', hc: 1,
    company: 'Zettlab吾云创新' });
  assert.ok(c.includes('（招聘方：Zettlab吾云创新）'), '括号标注招聘方');
  assert.ok(!c.includes('Zettlab吾云创新背景'), '不得再拼背景');
});

// 用例 7：5 年以上
test('S1-7 「5 年以上」年限解析', () => {
  const c = buildAutoSearchCriteria({ role: '架构师', city: '北京', company: 'X',
    notes: '负责平台架构设计，5年以上相关经验。' });
  assert.ok(c.includes('5 年以上工作经验'), '年限段=5 年以上');
});

// 用例 8：矛盾年限取首个
test('S1-8 矛盾年限取首个匹配', () => {
  const c = buildAutoSearchCriteria({ role: 'R', city: 'C', company: 'X',
    notes: '要求3-8年经验。另外5年以上也可以。' });
  assert.ok(c.includes('3-8 年工作经验'), '取首个匹配');
});

// 用例 9：jdText 与 job.notes 并存 → notes 优先
test('S1-9 jdText 传入时 job.notes 优先', () => {
  const c = buildAutoSearchCriteria({ role: 'R', city: 'C', company: 'X',
    notes: '库内权威JD内容' }, '外部传入的对话原文');
  assert.ok(c.includes('库内权威JD内容'), 'job.notes 优先');
  assert.ok(!c.includes('外部传入的对话原文'), 'jdText 不得同时出现');
  // notes 为空时 jdText 兜底生效
  const c2 = buildAutoSearchCriteria({ role: 'R', city: 'C', company: 'X' }, '外部传入的对话原文');
  assert.ok(c2.includes('外部传入的对话原文'), '无 notes 时 jdText 兜底');
});

// 用例 10：CRLF 行尾
test('S1-10 CRLF 行尾的 notes 正常处理', () => {
  const c = buildAutoSearchCriteria({ role: 'R', city: 'C', company: 'X',
    notes: '负责核心系统研发。\r\n3-5年经验。\r\n男生优先。' });
  assert.ok(!c.includes('\r'), 'CRLF 已规整');
  assert.ok(c.includes('3-5 年工作经验') && !c.includes('男生'), '年限与性别剥离正常');
});

// 用例 11：notes 全为歧视条件 → 剥完为空不输出空段
test('S1-11 notes 全为年龄/性别条件时无 JD 段', () => {
  const c = buildAutoSearchCriteria({ role: 'R', city: 'C', company: 'X',
    notes: '30岁以内。女生优先。' });
  assert.ok(!c.includes('JD 原文要点：'), '剥完为空不得输出空段');
});

// 用例 12：pipeline 回归（sm_bafc5d0f）已在上方主回归用例覆盖，此处补 sanitize/parse 纯函数
test('S1-12 sanitizeJdNotes/parseExperienceRange 纯函数行为', () => {
  assert.equal(sanitizeJdNotes(null), null);
  assert.equal(sanitizeJdNotes(''), null);
  assert.equal(sanitizeJdNotes('35岁以下'), null, '全为年龄条件剥完为空');
  assert.equal(parseExperienceRange(null), null);
  assert.equal(parseExperienceRange('无年限要求'), null);
  assert.equal(parseExperienceRange('3-8年工作经验'), '3-8 年');
  assert.equal(parseExperienceRange('8 年以上'), '8 年以上');
  assert.equal(parseExperienceRange('2024-2025年度预算'), null, '长数字串不误匹配');
});

// raw_json.notes 兜底（job.notes 权威列为空时）
test('S1-13 jobNotesText：notes 列空时从 raw_json.notes/requirements 兜底', () => {
  const job = { role: 'R', city: 'C', company: 'X',
    raw_json: JSON.stringify({ notes: 'raw_json 里的 JD 原文' }) };
  assert.equal(jobNotesText(job), 'raw_json 里的 JD 原文');
  const c = buildAutoSearchCriteria(job);
  assert.ok(c.includes('raw_json 里的 JD 原文'), 'raw_json.notes 兜底入判据');
  const job2 = { role: 'R', city: 'C', company: 'X',
    raw_json: JSON.stringify({ requirements: '任职要求文本' }) };
  assert.ok(buildAutoSearchCriteria(job2).includes('任职要求文本'), 'requirements 兜底');
  const job3 = { role: 'R', city: 'C', company: 'X', raw_json: 'not-json' };
  assert.equal(jobNotesText(job3), null, 'raw_json 损坏不抛错');
});

// S1-14（2026-10-21 链路回放盲区攻击）：生产 179 行「95后/90后」漏剥 + 3 个变体盲区
test('S1-14 年龄/性别变体盲区全剥除（生产回放实证）', () => {
  // token 级剥离：剥歧视词、保留后续业务信息（J1L0502 实例）
  const a = sanitizeJdNotes('95后  对标公司 可靠性经验');
  assert.ok(!a.includes('95后'), '95后 token 必须剥');
  assert.ok(a.includes('对标公司'), '后续业务信息必须保留');
  assert.ok(a.includes('可靠性经验'), '可靠性经验保留');
  // 90后优先
  assert.ok(!sanitizeJdNotes('90后优先，本科以上').includes('90后'));
  // 不超过N岁（吃后续短语避免残句）
  assert.ok(!sanitizeJdNotes('岗位职责若干。不超过35岁。其他待定。').includes('35岁'));
  // 只要男/女的、男性为佳 token 级
  assert.ok(!sanitizeJdNotes('岗位职责若干。只要男的。其他待定。').includes('只要男'));
  assert.ok(!sanitizeJdNotes('岗位职责若干。男性为佳。其他待定。').includes('男性为佳'));
});

// S1-15 误伤防护：时间表述与年限不得被年龄正则误剥
test('S1-15 年龄正则不误伤时间/年限表述', () => {
  // 「最多不超过5年」是年限表述（无「岁」），不得剥
  const a = sanitizeJdNotes('经验要求：1-3年，最多不超过5年，c端产品经验');
  assert.ok(a.includes('最多不超过5年'), '年限表述不误剥');
  // 「2010年后」「10年后」是时间表述，不得剥
  assert.ok(sanitizeJdNotes('2010年后成立的团队，做基础设施').includes('2010年后'));
  assert.ok(sanitizeJdNotes('预计10年后回本的项目').includes('10年后'));
  // 年限解析不受新增正则影响
  assert.equal(parseExperienceRange(sanitizeJdNotes('3-8年经验，95后')), '3-8 年', '剥95后不影响年限解析');
});

// S1-16 判据组装端到端：含盲区表述的生产型 JD
test('S1-16 含95后/只要男的的 JD 端到端判据无歧视残留', () => {
  const c = buildAutoSearchCriteria({ role: '可靠性工程师', city: '上海市', company: '某公司',
    notes: '95后 对标公司 可靠性经验，只要男的，3-8年经验' });
  assert.ok(!c.includes('95后') && !c.includes('只要男'), '判据无歧视残留');
  assert.ok(c.includes('对标公司') && c.includes('可靠性经验'), '业务信息保留');
  assert.ok(c.includes('3-8 年工作经验'), '年限正常传导');
});
