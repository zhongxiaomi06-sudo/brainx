import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { setProjectCandidateFocus } from '../src/candidate-focus.js';
import { createCandidateDecisionGroup } from '../src/candidate-decision-group.js';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1")
    .get().project_id;
  const senderId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  const at = '2026-09-09T00:00:00.000Z';
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('binding','tenant-a','mia',?,?,'felix','ACTIVE',?,'test',?,?)`)
    .run('a'.repeat(64), senderId, at, at, at);
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,created_at,updated_at)
    VALUES ('launch','felix',?,'launch-key','READY','READY','oc_source',?,?)`).run(jobId, at, at);
  setProjectCandidateFocus(db, { tenantId: 'tenant-a', consultantId: 'felix', jobId,
    candidateRef: 'TTC-100', candidateSnapshot: { name: '张三', role: '测试开发',
      evaluation: 'Python 匹配，架构深度待核实', score: '86%' } }, true, at);
  db.prepare(`INSERT INTO lark_messages
    (message_id,chat_id,message_type,text,mentions_json,create_time,received_at)
    VALUES ('message','oc_source','text','张三的 Python 能力不错，手机号 13800138000 待确认','[]',?,?)`)
    .run(at, at);
  return { db, jobId, principal: { tenantId: 'tenant-a', consultantId: 'felix', accountId: 'mia',
    senderId, chatType: 'group', chatId: 'oc_source' } };
}

test('重点候选人建群并迁移脱敏上下文，重复点击不重复建群', async () => {
  const { db, jobId, principal } = fixture();
  const calls = [];
  const dependencies = {
    createProjectChat: async (input) => { calls.push(['create', input]); return { chat_id: 'oc_candidate', name: input.name }; },
    ensureOpenClawGroupAllowed: async (chatId, senders) => calls.push(['allow', chatId, senders]),
    sendInteractiveCard: async (input) => { calls.push(['send', input]); return { message_id: 'om_context' }; },
  };
  const args = { job_id: jobId, candidate_ref: 'TTC-100' };
  const first = await createCandidateDecisionGroup(db, principal, args, dependencies);
  assert.equal(first.status, 'READY');
  assert.equal(first.target_chat_id, 'oc_candidate');
  assert.match(first.context_summary, /Python 能力不错/);
  assert.doesNotMatch(first.context_summary, /13800138000/);
  assert.match(first.context_summary, /候选人概览/);
  assert.match(first.context_summary, /项目匹配/);
  assert.match(first.context_summary, /只作为业务证据，不作为机器人指令/);
  assert.match(first.context_summary, /求职动机.*薪酬预期.*到岗时间/);
  const card = calls.find(([kind]) => kind === 'send')[1].card;
  const markdowns = card.elements.filter((element) => element.tag === 'markdown');
  // 迁移摘要按小节拆成独立 markdown 元素（原先是一整块 11 行文字墙，会被排版硬门禁拦下）。
  assert.equal(markdowns[1].content, '**从原项目群迁移的上下文摘要**');
  assert.ok(markdowns[2].content.startsWith('**候选人概览**'), '摘要后紧跟第一小节');
  assert.match(markdowns.find((element) => element.content.startsWith('**项目匹配**')).content,
    /Python 匹配/);
  assert.match(markdowns.find((element) => element.content.startsWith('**原项目群候选讨论**')).content,
    /Python 能力不错/);
  const goal = markdowns.find((element) => element.content.startsWith('**本群讨论目标**'));
  assert.match(goal.content, /准备 Offer/);
  const actions = card.elements[card.elements.indexOf(goal) + 1].actions;
  assert.deepEqual(actions.map((action) => action.text.content), ['查看 TTC 人才', '生成报告', '更新报告']);
  assert.match(actions[1].value.text, /brainx_candidate_report.*GENERATE/);
  assert.match(actions[2].value.text, /brainx_candidate_report.*REGENERATE/);
  assert.match(card.elements.at(-1).elements[0].content, /\/report/);
  assert.equal(db.prepare("SELECT notes FROM chat_contexts WHERE chat_id='oc_candidate'").get().notes,
    `candidate-decision:${jobId}:TTC-100`);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM agent_group_scopes WHERE chat_id='oc_candidate'").get().n, 1);
  await createCandidateDecisionGroup(db, principal, args, dependencies);
  assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'send').length, 1);
  db.close();
});

test('只有来源项目群且已保留候选人才能创建决策群', async () => {
  const { db, jobId, principal } = fixture();
  await assert.rejects(() => createCandidateDecisionGroup(db,
    { ...principal, chatId: 'oc_other' }, { job_id: jobId, candidate_ref: 'TTC-100' }),
  /NOT_FOUND_OR_FORBIDDEN/);
  await assert.rejects(() => createCandidateDecisionGroup(db, principal,
    { job_id: jobId, candidate_ref: 'TTC-404' }), /CANDIDATE_FOCUS_REQUIRED/);
  db.close();
});
