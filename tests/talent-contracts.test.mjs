import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCandidateFact,
  parseCandidateMatchBundle,
} from '../src/talent-contracts.js';

const ISO = '2026-09-03T08:00:00.000Z';
const HASH = 'a'.repeat(64);

function candidateFact(overrides = {}) {
  return {
    schema_version: 'candidate_fact_v1',
    fact_version_id: 'cfv_01',
    candidate_ref: 'cand_01',
    document: {
      document_ref: 'doc_01',
      source_format: 'pdf',
      content_hash: HASH,
      parser_version: 'docling-shadow-0.1',
      processed_at: ISO,
    },
    identity: {
      display_name: '张三',
      contact_ref: 'contact_01',
      evidence_refs: ['ev_name'],
    },
    work_experiences: [{
      company: '示例科技', title: '增长负责人', start_date: '2022-01',
      end_date: null, is_current: true, summary: '负责海外增长',
      achievements: ['搭建投放体系'], evidence_refs: ['ev_work'],
    }],
    education: [],
    skills: [{ name: 'Google Ads', normalized_name: 'google_ads',
      proficiency: 'EXPLICIT', evidence_refs: ['ev_skill'] }],
    constraints: [{ name: 'location', value: '上海',
      state: 'SUPPORTED', evidence_refs: ['ev_location'] }],
    evidence: [
      { evidence_ref: 'ev_name', field_path: 'identity.display_name', source_ref: 'doc_01',
        page: 1, excerpt_hash: HASH },
      { evidence_ref: 'ev_work', field_path: 'work_experiences.0', source_ref: 'doc_01',
        page: 1, excerpt_hash: HASH },
      { evidence_ref: 'ev_skill', field_path: 'skills.0', source_ref: 'doc_01',
        page: 1, excerpt_hash: HASH },
      { evidence_ref: 'ev_location', field_path: 'constraints.0', source_ref: 'doc_01',
        page: 2, excerpt_hash: HASH },
    ],
    quality: { status: 'READY', evidence_coverage: 0.92, unknown_fields: [], warnings: [] },
    ...overrides,
  };
}

function matchBundle(overrides = {}) {
  return {
    schema_version: 'candidate_match_bundle_v1',
    job_ref: 'job_01',
    match_run: {
      match_run_id: 'run_01', algorithm_version: 'shadow-v1',
      feature_schema_version: 'features-v1', completed_at: ISO,
    },
    page: { limit: 5, next_page_token: null },
    items: [{
      candidate_ref: 'cand_01', display_name_masked: '张*', rank: 1,
      strength: { score: 83, summary: '经历完整且成果有证据', evidence_refs: ['ev_work'] },
      job_fit: { score: 78, summary: '行业和投放能力匹配', evidence_refs: ['ev_skill'] },
      hard_conditions: [{ criterion: '上海办公', result: 'PASS', evidence_refs: ['ev_location'] }],
      gaps: ['薪资未确认'], risks: [], unknowns: ['到岗时间'],
      data_freshness: { fact_processed_at: ISO, status: 'FRESH' },
    }],
    data_scope: { scope: 'authorized_shortlist', purpose: 'candidate_review' },
    generated_at: ISO,
    ...overrides,
  };
}

test('candidate_fact_v1：接受有来源锚点的结构化事实', () => {
  const parsed = parseCandidateFact(candidateFact());
  assert.equal(parsed.schema_version, 'candidate_fact_v1');
  assert.equal(parsed.work_experiences[0].evidence_refs[0], 'ev_work');
});

test('candidate_fact_v1：UNKNOWN 约束可无证据，SUPPORTED 必须有证据', () => {
  assert.doesNotThrow(() => parseCandidateFact(candidateFact({
    constraints: [{ name: 'salary', value: null, state: 'UNKNOWN', evidence_refs: [] }],
  })));
  assert.throws(() => parseCandidateFact(candidateFact({
    constraints: [{ name: 'salary', value: '50k', state: 'SUPPORTED', evidence_refs: [] }],
  })), /evidence_refs/);
});

test('candidate_fact_v1：拒绝手机号、邮箱和简历原文等越界字段', () => {
  for (const forbidden of [
    { phone: '13800000000' },
    { email: 'person@example.com' },
    { resume_text: '完整简历原文' },
  ]) {
    assert.throws(() => parseCandidateFact(candidateFact(forbidden)));
  }
});

test('candidate_match_bundle_v1：候选人实力与职位匹配分开', () => {
  const parsed = parseCandidateMatchBundle(matchBundle());
  assert.equal(parsed.items[0].strength.score, 83);
  assert.equal(parsed.items[0].job_fit.score, 78);
});

test('candidate_match_bundle_v1：最多 20 人且分数范围为 0 到 100', () => {
  const item = matchBundle().items[0];
  assert.throws(() => parseCandidateMatchBundle(matchBundle({ items: Array(21).fill(item) })));
  assert.throws(() => parseCandidateMatchBundle(matchBundle({
    items: [{ ...item, job_fit: { ...item.job_fit, score: 101 } }],
  })));
});

test('candidate_match_bundle_v1：严格拒绝联系方式、原文和飞书路由字段', () => {
  const item = matchBundle().items[0];
  for (const forbidden of [
    { phone: '13800000000' }, { email: 'x@example.com' },
    { resume_text: 'raw' }, { chat_id: 'oc_secret' },
  ]) {
    assert.throws(() => parseCandidateMatchBundle(matchBundle({ items: [{ ...item, ...forbidden }] })));
  }
});
