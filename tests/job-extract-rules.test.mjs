/** job-extract-rules.test.mjs — E1 规则层纯函数抽取（测试先行）。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4-§5；
 * 规则层零成本、永远在（AI kill-switch 关闭时的保底路径）；
 * 每个抽取字段必须带 evidence 原文引用（langextract 原文锚定思想）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRules, isJobRelevant, parseOfferGroupName } from '../src/job-extract/classify.js';

test('parseOfferGroupName: 标准 Offer-群名 解析出 团队/候选人/岗位', () => {
  const r = parseOfferGroupName('Offer-WD-MY-从容地-UIUX');
  assert.ok(r, '应命中 Offer- 前缀');
  assert.equal(r.role, 'UIUX');
  assert.equal(r.candidate, '从容地');
  assert.equal(r.team, 'WD-MY');
});

test('parseOfferGroupName: 非 Offer 前缀返回 null', () => {
  assert.equal(parseOfferGroupName('WD-职位优先级'), null);
  assert.equal(parseOfferGroupName(''), null);
  assert.equal(parseOfferGroupName(null), null);
});

test('isJobRelevant: 职位关键词命中为 true', () => {
  for (const t of ['这个岗位急招，HC 2 人', 'offer 谈得怎么样了', '周四约一面', '候选人 base 上海']) {
    assert.equal(isJobRelevant(t), true, `应命中: ${t}`);
  }
});

test('isJobRelevant: 无关消息为 false', () => {
  for (const t of ['明天团建记得带伞', '哈哈', '']) {
    assert.equal(isJobRelevant(t), false, `不应命中: ${t}`);
  }
});

test('extractRules: HC 数字与原文锚定', () => {
  const r = extractRules('这个岗位急招，HC 2 人，base 上海');
  assert.equal(r.hc.number, 2);
  assert.ok(r.hc.evidence.includes('HC 2'), 'evidence 必须是原文片段');
  assert.equal(r.hc.confidence, 'high');
});

test('extractRules: 城市 base 语法与原文锚定', () => {
  const r = extractRules('候选人 base 上海，下周到岗');
  assert.equal(r.city.text, '上海');
  assert.ok(r.city.evidence.includes('base 上海'));
});

test('extractRules: 岗位名「急招后端工程师」与原文锚定', () => {
  const r = extractRules('客户那边急招后端工程师，要求 Go 三年');
  assert.equal(r.role.text, '后端工程师');
  assert.ok(r.role.evidence.includes('急招后端工程师'));
});

test('extractRules: 公司名后缀模式与原文锚定', () => {
  const r = extractRules('星曜科技这个岗还在招');
  assert.equal(r.company.text, '星曜科技');
  assert.ok(r.company.evidence.includes('星曜科技'));
});

test('extractRules: 状态关键词映射 active_state', () => {
  assert.equal(extractRules('这个项目先暂停了').active_state.state, 'ON_HOLD');
  assert.equal(extractRules('岗位关闭了别推人').active_state.state, 'CLOSED');
  assert.equal(extractRules('候选人接了 offer 准备入职').active_state.state, 'COMPLETED');
  assert.equal(extractRules('急招，本周就要人').active_state.state, 'OPEN');
});

test('extractRules: 无命中时 active_state 兜底 UNKNOWN 且 evidence 为 null', () => {
  const r = extractRules('随便聊聊近况');
  assert.equal(r.active_state.state, 'UNKNOWN');
  assert.equal(r.active_state.evidence, null);
});

test('extractRules: pipeline 阶段映射（一面→INTERVIEW）', () => {
  const r = extractRules('约了周四一面');
  assert.equal(r.pipeline.stage, 'INTERVIEW');
  assert.ok(r.pipeline.evidence.includes('一面'));
});

test('extractRules: 规则层字段置信度统一 high（默认兜底除外）', () => {
  const r = extractRules('HC 2，base 上海');
  assert.equal(r.company, null, '无公司证据时不得编造');
  for (const f of [r.hc, r.city]) assert.equal(f.confidence, 'high');
  assert.equal(r.active_state.state, 'UNKNOWN');
  assert.equal(r.active_state.confidence, 'low');
});
