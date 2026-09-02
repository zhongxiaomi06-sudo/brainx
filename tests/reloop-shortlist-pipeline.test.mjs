import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReloopCandidateFact,
  buildReloopMatchPayload,
  normalizeReloopScore,
} from '../src/reloop-shortlist-pipeline.js';

const profile = {
  id: 42,
  name: '张三',
  contact_phone: '13800000000',
  contact_email: 'candidate@example.com',
  base_location: '上海',
  company: '示例科技',
  position: 'HRBP',
  work_years: 8,
  value_score: 0.82,
  skills: ['招聘', '组织发展'],
  expected_salary: '待沟通',
  updated_at: '2026-09-03T08:00:00.000Z',
  source_payload: {
    basic: { name: { cn_name: '张三' }, phone: ['13800000000'], location: ['上海'] },
    work: { items: [{ company_name: '示例科技', position: 'HRBP', start_time: '2020-01',
      end_time: '至今', description: '负责招聘与组织发展，定期做招聘漏斗数据分析' }] },
    education: { items: [{ school_name: '示例大学', degree: '本科', major: '管理学',
      start_time: '2012', end_time: '2016' }] },
  },
};

test('reloop 格式化：只产出结构化事实与哈希证据，不带联系方式', () => {
  const fact = buildReloopCandidateFact(profile, { processedAt: '2026-09-03T09:00:00.000Z' });
  assert.equal(fact.schema_version, 'candidate_fact_v1');
  assert.equal(fact.identity.display_name, '张三');
  assert.equal(fact.work_experiences[0].company, '示例科技');
  assert.equal(fact.education[0].school, '示例大学');
  assert.ok(fact.skills.some((skill) => skill.name === '招聘'));
  assert.ok(fact.evidence.every((entry) => /^[a-f0-9]{64}$/.test(entry.excerpt_hash)));
  const serialized = JSON.stringify(fact);
  assert.doesNotMatch(serialized, /13800000000|candidate@example\.com/);
});

test('reloop 格式化：匹配解释保持实力与岗位匹配分离', () => {
  const fact = buildReloopCandidateFact(profile, { processedAt: '2026-09-03T09:00:00.000Z' });
  const payload = buildReloopMatchPayload(profile, {
    score: 0.76,
    score_breakdown: { match_detail: { skill_hits: ['招聘'], skill_jd_count: 3 } },
  }, { required_skills: ['招聘', '数据整理', '薪酬'], location: '未提供' }, fact);
  assert.match(payload.strength_summary, /8/);
  assert.match(payload.job_fit_summary, /76/);
  assert.ok(payload.job_fit_evidence_refs.length > 0);
  assert.ok(payload.gaps.some((gap) => gap.includes('薪酬')));
  assert.equal(payload.hard_conditions.find((item) => item.criterion === '必需技能：招聘').result, 'PASS');
  assert.equal(payload.hard_conditions.find((item) => item.criterion === '必需技能：数据整理').result, 'PASS');
  assert.equal(payload.hard_conditions.some((item) => item.criterion.startsWith('工作地点')), false);
});

test('reloop 分数：兼容 0–1 与 0–100 两种来源并收口边界', () => {
  assert.equal(normalizeReloopScore(0.82), 82);
  assert.equal(normalizeReloopScore(82), 82);
  assert.equal(normalizeReloopScore(200), 100);
  assert.equal(normalizeReloopScore(null), 0);
});
