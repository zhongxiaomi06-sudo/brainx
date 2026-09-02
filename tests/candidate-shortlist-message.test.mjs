import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCandidateShortlistMessage } from '../src/candidate-shortlist-message.js';

test('候选推荐文案：固定输出口径、双分数和待确认项，不展开证据或身份', () => {
  const message = formatCandidateShortlistMessage({
    schema_version: 'candidate_match_bundle_v1', job_ref: 'reloop-position:31',
    match_run: { match_run_id: 'run_1', algorithm_version: 'reloop-existing-recommendation-v1',
      feature_schema_version: 'candidate_fact_v1', completed_at: '2026-09-03T08:00:00.000Z' },
    page: { limit: 3, next_page_token: null },
    items: [{ candidate_ref: 'reloop-profile:1', display_name_masked: '张*', rank: 1,
      strength: { score: 82, summary: '8 年 HRBP 经验', evidence_refs: ['ev_work'] },
      job_fit: { score: 76, summary: '招聘经验匹配', evidence_refs: ['ev_skill'] },
      hard_conditions: [], gaps: ['员工关系待确认'], risks: [], unknowns: ['到岗时间未确认'],
      data_freshness: { fact_processed_at: '2026-09-03T08:00:00.000Z', status: 'FRESH' } }],
    data_scope: { scope: 'authorized_shortlist', purpose: 'candidate_review' },
    generated_at: '2026-09-03T08:00:00.000Z',
  }, { jobName: '沐仞科技 HR岗' });
  assert.match(message, /张\*｜实力 82｜匹配 76/);
  assert.match(message, /不是 BrainX 新算法重排/);
  assert.match(message, /员工关系待确认/);
  assert.doesNotMatch(message, /ev_work|reloop-profile/);
});
