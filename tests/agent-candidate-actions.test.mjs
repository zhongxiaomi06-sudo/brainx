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
    job_id: jobId, candidate_ref: 'candidate-x', action: 'KEEP_FOR_REVIEW', confirm: true,
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

test('OpenMai 候选可进入项目，重点名单在项目成员间共享且不能跨项目', async () => {
  const { db, context, jobId } = fixture();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'openmai-candidate-1', name: '李四', evaluation: '待核实', resume_url: null },
  ] })}\n-->`;
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at)
    VALUES (?,?,'done',?,'om-case','2026-09-07T00:00:00.000Z','2026-09-07T00:01:00.000Z')`)
    .run(jobId, 'felix', resultText);
  let shortlistCalls = 0;
  const handlers = createCandidateActionToolHandlers({ db, candidateShortlistFn: async () => {
    shortlistCalls += 1;
    return { items: [], page: { next_page_token: null } };
  } });
  const added = await handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'openmai-candidate-1', action: 'ADD_TO_PROJECT', confirm: true,
  }, context);
  assert.equal(added.data.candidate_ref, 'openmai-candidate-1');
  assert.equal(shortlistCalls, 0, '项目找人结果已授权时不依赖外部 shortlist 可用性');
  assert.equal((await handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'openmai-candidate-1', action: 'MARK_PREPARING', confirm: true,
  }, context)).data.outreach_state, 'PREPARING');
  await assert.rejects(() => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'openmai-candidate-x', action: 'ADD_TO_PROJECT', confirm: true,
  }, context), /NOT_FOUND_OR_FORBIDDEN/);
  const other = { principal: { ...context.principal, consultantId: 'mia' } };
  await assert.rejects(() => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'openmai-candidate-1', action: 'ADD_TO_PROJECT', confirm: true,
  }, other), /NOT_FOUND_OR_FORBIDDEN/);
  db.prepare(`INSERT INTO job_memberships
    (consultant_id,project_id,relation,source,valid_from)
    VALUES ('mia',?,'OTHER_CONSULTANT','TEST','2026-09-09T00:00:00.000Z')`).run(jobId);
  const kept = await handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'openmai-candidate-1', action: 'KEEP_FOR_REVIEW', confirm: true,
  }, other);
  assert.equal(kept.data.focus_status, 'FOCUSED');
  assert.equal(db.prepare(`SELECT selected_by FROM project_candidate_focus
    WHERE position_id=? AND candidate_ref=?`).get(jobId, 'openmai-candidate-1').selected_by, 'mia');
  const removed = await handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'openmai-candidate-1', action: 'REMOVE_FROM_REVIEW', confirm: true,
  }, context);
  assert.equal(removed.data.focus_status, 'REMOVED');
  db.close();
});

test('候选卡片按钮发送 TTC 链接，自然语言建群可自动加入重点名单', async () => {
  const { db, jobId } = fixture();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1
${JSON.stringify({ candidates: [{ candidate_ref: 'openmai-card-1', name: '李四',
  role: '甲公司 / 算法工程师', experience: '6 年', city: '上海', education: '硕士',
  evaluation: '大模型经验匹配，管理跨度待核实，手机号 13800138000', score: '88%',
  talent_url: 'https://app.ttcadvisory.com/app/talent/openmai-card-1' }] })}
-->`;
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at)
    VALUES (?,?,'done',?,'om-card','2026-09-09T00:00:00.000Z','2026-09-09T00:01:00.000Z')`)
    .run(jobId, 'felix', resultText);
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,created_at,updated_at)
    VALUES ('launch-card','felix',?,'launch-card-key','READY','READY','oc_project',
      '2026-09-09T00:00:00.000Z','2026-09-09T00:00:00.000Z')`).run(jobId);
  const sent = [];
  const created = [];
  const handlers = createCandidateActionToolHandlers({ db,
    candidateShortlistFn: async () => ({ items: [], page: { next_page_token: null } }),
    sendInteractiveCardFn: async (input) => { sent.push(input); return { message_id: 'om-card' }; },
    createCandidateDecisionGroupFn: async (innerDb, _principal, args) => {
      created.push(args);
      assert.equal(innerDb.prepare(`SELECT focus_status FROM project_candidate_focus
        WHERE position_id=? AND candidate_ref=?`).get(jobId, args.candidate_ref).focus_status, 'FOCUSED');
      return { decision_group_id: 'decision-1', status: 'READY' };
    },
  });
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix',
    chatType: 'group', chatId: 'oc_project' } };
  const focusedResult = await handlers.brainx_candidate_workflow({ job_id: jobId,
    candidate_ref: 'openmai-card-1', action: 'KEEP_FOR_REVIEW', confirm: true }, context);
  assert.equal(focusedResult.data.focus_status, 'FOCUSED');
  assert.equal(focusedResult.data.talent_card_status, 'sent');
  assert.equal(sent.length, 1);
  const shared = await handlers.brainx_candidate_workflow({ job_id: jobId,
    candidate_ref: 'openmai-card-1', action: 'SEND_TALENT_CARD', confirm: true }, context);
  assert.equal(shared.data.talent_card_status, 'sent');
  assert.equal(sent[0].target, 'oc_project');
  assert.match(JSON.stringify(sent[0].card), /李四|88%|查看 TTC 链接|初筛通过|加入reloop/);
  assert.match(JSON.stringify(sent[0].card), /\[BRAINTEX_CANDIDATE_KEEP\] 职位 \S+ 候选人 openmai-card-1/);
  assert.match(JSON.stringify(sent[0].card), /\[BRAINTEX_TALENT_ADD\] 职位 \S+ 候选人 openmai-card-1/);
  // F1：primary 已从「查看 TTC 链接」这个纯跳转交给「初筛通过」，跳转按钮降到末位。
  const shareActions = sent[0].card.elements[2].actions;
  assert.equal(shareActions[0].text.content, '初筛通过', '真实业务动作必须是主按钮');
  assert.equal(shareActions[0].type, 'primary');
  assert.match(shareActions.find((action) => action.multi_url).multi_url.url,
    /app\.ttcadvisory\.com\/app\/talent\/openmai-card-1/);
  assert.doesNotMatch(JSON.stringify(sent[0].card), /简历\.pdf|138\d{8}/);
  await assert.rejects(() => handlers.brainx_candidate_workflow({ job_id: jobId,
    candidate_ref: 'openmai-card-1', action: 'SEND_TALENT_CARD', confirm: true },
  { principal: { ...context.principal, chatType: 'p2p', chatId: 'ou_felix' } }),
  /NOT_FOUND_OR_FORBIDDEN/);

  await assert.rejects(() => handlers.brainx_candidate_workflow({ job_id: jobId,
    candidate_ref: 'openmai-card-1', action: 'CREATE_DECISION_GROUP', confirm: true },
  { principal: { ...context.principal, chatId: 'oc_other' } }), /NOT_FOUND_OR_FORBIDDEN/);
  assert.equal(db.prepare(`SELECT focus_status FROM project_candidate_focus
    WHERE position_id=? AND candidate_ref=?`).get(jobId, 'openmai-card-1').focus_status, 'FOCUSED',
  '错误群建群被拒绝时不能改变已有重点关注状态');

  const group = await handlers.brainx_candidate_workflow({ job_id: jobId,
    candidate_ref: 'openmai-card-1', action: 'CREATE_DECISION_GROUP', confirm: true }, context);
  assert.equal(group.data.decision_group_status, 'READY');
  assert.equal(group.data.added_to_project_focus, false);
  assert.equal(created.length, 1);
  db.close();
});

test('项目群按钮优先使用 OpenMai 链接，并可从 TTC 回查未附链接的真实 PDF', async () => {
  const { db, jobId } = fixture();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1
${JSON.stringify({ candidates: [
    { candidate_ref: 'openmai-resume-1', name: '李四', evaluation: '匹配',
      resume_url: 'https://gateway.ttcadvisory.com/resume/1.pdf' },
    { candidate_ref: 'openmai-no-resume', name: '王五', evaluation: '待核实', resume_url: null },
  ] })}
-->`;
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at)
    VALUES (?,?,'done',?,'om-resume','2026-09-07T00:00:00.000Z','2026-09-07T00:01:00.000Z')`)
    .run(jobId, 'felix', resultText);
  const downloads = [];
  const ttcLists = [];
  const ttcDownloads = [];
  const sends = [];
  const handlers = createCandidateActionToolHandlers({ db,
    getAuthorizedTtcJwtFn: () => 'team-jwt',
    downloadResumeFn: async (url, jwt) => { downloads.push({ url, jwt }); return Buffer.from('%PDF-1.7'); },
    listTtcResumeAttachmentsFn: async (candidateRef, jwt) => {
      ttcLists.push({ candidateRef, jwt });
      return [{ name: '../王五原始简历.pdf', url: 'https://api.ttcadvisory.com/redirect/resume' }];
    },
    downloadTtcResumePdfFn: async (url, jwt) => {
      ttcDownloads.push({ url, jwt }); return Buffer.from('%PDF-1.7 TTC');
    },
    sendPdfFileFn: async (input) => { sends.push(input); return { message_id: 'om_resume' }; },
  });
  const group = { principal: { tenantId: 'tenant-a', consultantId: 'felix',
    chatType: 'group', chatId: 'oc_project' } };
  const sent = await handlers.brainx_send_candidate_resume({
    job_id: jobId, candidate_ref: 'openmai-resume-1', confirm: true,
  }, group);
  assert.equal(sent.data.delivery_status, 'sent');
  assert.deepEqual(downloads, [{ url: 'https://gateway.ttcadvisory.com/resume/1.pdf', jwt: 'team-jwt' }]);
  assert.equal(sends[0].target, 'oc_project');
  assert.equal(sends[0].fileName, '李四-简历.pdf');
  assert.match(sends[0].idempotencyKey, /^candidate-resume-[a-f0-9]{32}$/);
  const fallback = await handlers.brainx_send_candidate_resume({
    job_id: jobId, candidate_ref: 'openmai-no-resume', confirm: true,
  }, group);
  assert.equal(fallback.data.delivery_status, 'sent');
  assert.deepEqual(ttcLists, [{ candidateRef: 'openmai-no-resume', jwt: 'team-jwt' }]);
  assert.deepEqual(ttcDownloads, [{ url: 'https://api.ttcadvisory.com/redirect/resume', jwt: 'team-jwt' }]);
  assert.equal(sends[1].fileName, '.._王五原始简历.pdf');
  await assert.rejects(() => handlers.brainx_send_candidate_resume({
    job_id: jobId, candidate_ref: 'openmai-resume-1', confirm: true,
  }, { principal: { ...group.principal, chatType: 'p2p' } }), /NOT_FOUND_OR_FORBIDDEN/);
  db.close();
});

test('TTC 也没有候选人附件时明确返回简历不可用', async () => {
  const { db, jobId } = fixture();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1
${JSON.stringify({ candidates: [
    { candidate_ref: 'openmai-no-attachment', name: '赵六', evaluation: '待核实', resume_url: null },
  ] })}
-->`;
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at)
    VALUES (?,?,'done',?,'om-none','2026-09-07T00:00:00.000Z','2026-09-07T00:01:00.000Z')`)
    .run(jobId, 'felix', resultText);
  const handlers = createCandidateActionToolHandlers({ db,
    getAuthorizedTtcJwtFn: () => 'team-jwt', listTtcResumeAttachmentsFn: async () => [],
  });
  const group = { principal: { tenantId: 'tenant-a', consultantId: 'felix',
    chatType: 'group', chatId: 'oc_project' } };
  await assert.rejects(() => handlers.brainx_send_candidate_resume({
    job_id: jobId, candidate_ref: 'openmai-no-attachment', confirm: true,
  }, group), /RESUME_NOT_AVAILABLE/);
  db.close();
});

// 冲刺 T12：一键加入人才库——真实写 RDS（幂等），RDS 不可写时降级为待同步，不阻塞演示闭环。
test('一键加入人才库：成功、幂等、降级与未授权拒绝', async () => {
  const { db, jobId } = fixture();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1
${JSON.stringify({ candidates: [{ candidate_ref: 'openmai-talent-1', name: '王五',
  role: '乙公司 / 研发负责人', evaluation: '匹配 90%', score: '90%' }] })}
-->`;
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at)
    VALUES (?,?,'done',?,'om-talent','2026-09-12T00:00:00.000Z','2026-09-12T00:01:00.000Z')`)
    .run(jobId, 'felix', resultText);
  const context = { principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'p2p' } };
  const calls = [];
  const handlers = createCandidateActionToolHandlers({ db,
    addTalentFn: async (input) => { calls.push(input); return { id: 42, already: calls.length > 1 }; },
  });
  const first = await handlers.brainx_talent_pool_add({
    job_id: jobId, candidate_ref: 'openmai-talent-1', confirm: true }, context);
  assert.equal(first.data.talent_id, 42);
  assert.equal(first.data.already, false);
  assert.match(calls[0].summary, /^\[ref:openmai-talent-1\] 职位:/);
  assert.equal(calls[0].name, '王五');
  const second = await handlers.brainx_talent_pool_add({
    job_id: jobId, candidate_ref: 'openmai-talent-1', confirm: true }, context);
  assert.equal(second.data.already, true);
  assert.ok(second.unknowns.some((u) => u.includes('已在人才库')), '幂等命中要明说已收藏');

  const failing = createCandidateActionToolHandlers({ db,
    addTalentFn: async () => { throw new Error('RDS down'); } });
  const degraded = await failing.brainx_talent_pool_add({
    job_id: jobId, candidate_ref: 'openmai-talent-1', confirm: true }, context);
  assert.equal(degraded.data.sync_pending, true, 'RDS 不可写必须降级为待同步而不是 500');
  assert.ok(degraded.unknowns.some((u) => u.includes('同步中')));

  await assert.rejects(() => handlers.brainx_talent_pool_add({
    job_id: jobId, candidate_ref: 'candidate-x', confirm: true }, context), /NOT_FOUND_OR_FORBIDDEN/);
  await assert.rejects(() => handlers.brainx_talent_pool_add({
    job_id: jobId, candidate_ref: 'openmai-talent-1', confirm: false }, context), /INVALID_ARGUMENT/);
  db.close();
});
