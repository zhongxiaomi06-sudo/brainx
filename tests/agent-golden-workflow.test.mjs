import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { createProductionToolRegistry } from '../src/agent-gateway/tool-registry.js';

const ISO = '2026-09-03T08:00:00.000Z';
const candidate = {
  candidate_ref: 'cand-a', display_name_masked: '张*', rank: 1,
  profile: { current_city: '上海', recent_experiences: [], education: [], skills: ['招聘'] },
  strength: { score: 82, summary: '交付事实完整', evidence_refs: ['ev-work'] },
  job_fit: { score: 78, summary: '方向匹配', evidence_refs: ['ev-work'] },
  hard_conditions: [{ criterion: '上海', result: 'PASS', evidence_refs: ['ev-city'] }],
  gaps: ['团队规模待确认'], risks: [], unknowns: ['到岗时间'],
  data_freshness: { fact_processed_at: ISO, status: 'FRESH' },
};
const bundle = {
  schema_version: 'candidate_match_bundle_v1', job_ref: 'job-placeholder',
  job_context: { title: 'HR 经理', summary: null, experience_requirement: '5年', education_requirement: null,
    location: '上海', required_skills: ['招聘'], preferred_skills: [], responsibilities: [], unknowns: [] },
  match_run: { match_run_id: 'match-run-a', algorithm_version: 'production-v1', feature_schema_version: 'features-v1', completed_at: ISO },
  page: { limit: 5, next_page_token: null }, items: [candidate],
  data_scope: { scope: 'authorized_shortlist', purpose: 'candidate_review' }, generated_at: ISO,
};
const fact = {
  schema_version: 'candidate_fact_v1', fact_version_id: 'fact-a', candidate_ref: 'cand-a',
  document: { document_ref: 'doc-a', source_format: 'legacy_text', content_hash: 'a'.repeat(64), parser_version: 'v1', processed_at: ISO },
  identity: { display_name: '张三', current_city: '上海', evidence_refs: ['ev-name'] },
  work_experiences: [], education: [], skills: [{ name: '招聘', normalized_name: '招聘', proficiency: 'EXPLICIT', evidence_refs: ['ev-work'] }],
  constraints: [{ name: 'availability', value: null, state: 'UNKNOWN', evidence_refs: [] }],
  evidence: [{ evidence_ref: 'ev-name', field_path: 'identity.display_name', source_ref: 'doc-a', excerpt_hash: 'a'.repeat(64) },
    { evidence_ref: 'ev-work', field_path: 'skills.0', source_ref: 'doc-a', excerpt_hash: 'a'.repeat(64) }],
  quality: { status: 'READY', evidence_coverage: 0.8, unknown_fields: ['availability'], warnings: [] },
};

function context(consultantId, purpose) {
  return { principal: { tenantId: 'tenant-a', consultantId, chatType: 'p2p', purpose } };
}

test('22 个生产工具全部接入，黄金读取工作流连续完成', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  recommend(db, 'felix', { top: 5 });
  const projectId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO integration_jobs
    (job_id, tenant_id, consultant_id, kind, idempotency_key, status, payload_json, requested_at, updated_at)
    VALUES ('async-a','tenant-a','felix','SEARCH','idem-a','PENDING','{}',?,?)`).run(at, at);
  const registry = createProductionToolRegistry({ db, talentDependencies: {
    candidateShortlistFn: async (input) => ({ ...bundle, job_ref: input.jobId,
      data_scope: { ...bundle.data_scope, purpose: input.purpose } }),
    loadCandidateFactFn: async () => fact,
  } });
  assert.equal(registry.names().length, 22);
  const before = db.prepare('SELECT COUNT(*) n FROM decision_events').get().n;

  const me = await registry.execute('brainx_me_context', {}, context('felix', 'self_context'));
  const brief = await registry.execute('brainx_daily_brief', { limit: 3 }, context('felix', 'daily_brief'));
  const job = await registry.execute('brainx_job_assessment', { job_id: projectId }, context('felix', 'job_review'));
  const shortlist = await registry.execute('brainx_candidate_shortlist', { job_id: projectId, limit: 3 }, context('felix', 'candidate_review'));
  const candidateFacts = await registry.execute('brainx_candidate_facts', { candidate_ref: 'cand-a', purpose: 'candidate_review' }, context('felix', 'candidate_review'));
  const fit = await registry.execute('brainx_candidate_fit', { job_id: projectId, candidate_ref: 'cand-a' }, context('felix', 'candidate_review'));
  const gaps = await registry.execute('brainx_gap_questions', { object_type: 'candidate', object_ref: 'cand-a', job_id: projectId }, context('felix', 'candidate_review'));
  const prep = await registry.execute('brainx_interview_prep', { job_id: projectId, candidate_ref: 'cand-a' }, context('felix', 'interview_prep'));
  const review = await registry.execute('brainx_personal_review', { date_from: '2026-01-01', date_to: '2026-12-31' }, context('felix', 'personal_review'));
  const status = await registry.execute('brainx_run_status', { run_id: 'async-a' }, context('felix', 'run_status'));

  assert.equal(me.data.consultant_ref, 'self');
  assert.ok(brief.recommendations.length > 0);
  assert.equal(job.data.job.project_id, projectId);
  assert.equal(shortlist.recommendations[0].candidate_ref, 'cand-a');
  assert.equal(candidateFacts.data.display_name_masked, '张*');
  assert.equal(fit.data.strength.score, 82);
  assert.ok(gaps.data.questions.length > 0);
  assert.ok(prep.data.questions.length > 0);
  assert.equal(review.data.consultant_ref, 'self');
  assert.equal(status.data.status, 'PENDING');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM decision_events').get().n, before);
});
