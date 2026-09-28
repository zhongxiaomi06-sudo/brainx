/** judgment-extract-rules.test.mjs — 顾问判断规则层 + schema 契约（specs/016）。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 纪律同 job-extract：宁缺勿错（无原文锚定的字段丢弃）、规则层保守（只抓显式句型）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractJudgmentRules, isJudgmentRelevant, mapJudgmentLlmFields,
} from '../src/judgment-extract/classify.js';
import { validateJudgmentDraft } from '../src/judgment-extract/schema.js';

test('相关性：判断关键词命中 / 闲聊不命中', () => {
  assert.equal(isJudgmentRelevant('客户说：这个方向不接受异地'), true);
  assert.equal(isJudgmentRelevant('候选人因为薪资太贵被拒了'), true);
  assert.equal(isJudgmentRelevant('明天团建记得带伞'), false);
  assert.equal(isJudgmentRelevant(''), false);
  assert.equal(isJudgmentRelevant(null), false);
});

test('规则层：显式"客户说不接受"句型 → CONSTRAINT，带原文 evidence', () => {
  const text = '星曜科技说：不接受异地候选人，必须base上海';
  const f = extractJudgmentRules(text);
  assert.equal(f.subject.ref, '星曜科技');
  assert.equal(f.subject.type, 'CLIENT_COMPANY');
  assert.equal(f.kind, 'CONSTRAINT');
  assert.equal(f.statement.text, '不接受异地候选人');
  assert.ok(text.includes(f.statement.evidence), 'evidence 必须是原文片段');
  assert.equal(f.confidence, 'high');
});

test('规则层："只要/必须"句型 → PREFERENCE', () => {
  const f = extractJudgmentRules('煌炎科技要求：只要有大厂背景的候选人');
  assert.equal(f.kind, 'PREFERENCE');
  assert.equal(f.subject.ref, '煌炎科技');
  assert.equal(f.statement.text, '只要有大厂背景的候选人');
});

test('规则层：有相关关键词但无显式句型 → statement=null（消费层 skip，宁缺勿错）', () => {
  const f = extractJudgmentRules('这个候选人因为最近跳槽太频繁，我们再看看');
  assert.equal(f.statement, null);
});

test('schema：合法草稿通过；缺 evidence / 超长 statement 被拒', () => {
  const ok = validateJudgmentDraft({
    subject: { type: 'CLIENT_COMPANY', ref: '星曜科技', evidence: '星曜科技说' },
    kind: 'CONSTRAINT',
    statement: { text: '不接受异地候选人', evidence: '不接受异地候选人' },
    confidence: 'high',
    event_refs: [],
  });
  assert.equal(ok.ok, true);

  const noEvidence = validateJudgmentDraft({
    subject: null, kind: 'PREFERENCE',
    statement: { text: '只要硕士', evidence: '' }, confidence: 'low', event_refs: [],
  });
  assert.equal(noEvidence.ok, false);

  const tooLong = validateJudgmentDraft({
    subject: null, kind: 'EVALUATION',
    statement: { text: 'x'.repeat(121), evidence: 'x' }, confidence: 'low', event_refs: [],
  });
  assert.equal(tooLong.ok, false);
});

test('LLM 映射：evidence 不在原文中出现的字段一律丢弃（防幻觉锚定）', () => {
  const src = '客户说只要硕士学历的候选人';
  const out = {
    subject: { type: 'CLIENT_COMPANY', ref: '某客户', evidence: '原文里根本没有这句话' },
    kind: 'PREFERENCE',
    statement: { text: '只要硕士学历', evidence: '只要硕士学历' },
  };
  const f = mapJudgmentLlmFields(out, src);
  assert.equal(f.statement.text, '只要硕士学历');
  assert.equal(f.subject, null, 'subject evidence 不在原文 → 丢弃');
  assert.equal(f.confidence, 'high', 'statement evidence 重合原文 → high');
});

test('LLM 映射：kind 非法 / statement 无效 → 整条无判断', () => {
  const src = '客户说不接受异地';
  const bad = mapJudgmentLlmFields(
    { subject: null, kind: 'MAYBE', statement: { text: '不接受异地', evidence: '不接受异地' } }, src);
  assert.equal(bad.statement, null);
  const empty = mapJudgmentLlmFields(
    { subject: null, kind: 'PREFERENCE', statement: { text: '', evidence: '' } }, src);
  assert.equal(empty.statement, null);
});
