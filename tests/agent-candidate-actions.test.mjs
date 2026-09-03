import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createCandidateActionToolHandlers } from '../src/agent-gateway/tools-candidate-actions.js';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const handlers = createCandidateActionToolHandlers({ db, candidateShortlistFn: async () => ({
    items: [{ candidate_ref: 'candidate-a' }], page: { next_page_token: null },
  }) });
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } };
  return { db, jobId, handlers, context };
}

test('候选人从加入项目一路记录到客户提交和面试', async () => {
  const { handlers, context, jobId } = fixture();
  const act = async (action) => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'candidate-a', action, note: `完成 ${action}`, confirm: true,
  }, context);
  assert.equal((await act('ADD_TO_PROJECT')).data.milestone, 'DISCOVERED');
  const preparing = await act('MARK_PREPARING');
  assert.equal(preparing.data.outreach_state, 'PREPARING');
  assert.equal((await act('MARK_PREPARING')).data.version, preparing.data.version, '同状态重试必须幂等');
  assert.equal((await act('RECORD_OUTREACH_SENT')).data.outreach_state, 'SENT');
  assert.equal((await act('RECORD_REPLIED')).data.outreach_state, 'REPLIED');
  assert.equal((await act('SUBMIT_TO_CLIENT')).data.milestone, 'SUBMITTED');
  assert.equal((await act('MOVE_TO_INTERVIEW')).data.milestone, 'INTERVIEW');
});

test('候选流程拒绝未授权候选人、未确认写入和非法跳步', async () => {
  const { handlers, context, jobId } = fixture();
  await assert.rejects(() => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'candidate-x', action: 'ADD_TO_PROJECT', confirm: true,
  }, context), /NOT_FOUND_OR_FORBIDDEN/);
  await assert.rejects(() => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'candidate-a', action: 'ADD_TO_PROJECT', confirm: false,
  }, context), /INVALID_ARGUMENT/);
  await handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'candidate-a', action: 'ADD_TO_PROJECT', confirm: true,
  }, context);
  await assert.rejects(() => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'candidate-a', action: 'MOVE_TO_INTERVIEW', confirm: true,
  }, context), /INVALID_ARGUMENT/);
});
