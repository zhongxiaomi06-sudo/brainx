import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { setProjectCandidateFocus } from '../src/candidate-focus.js';
import { createCandidateDecisionGroup } from '../src/candidate-decision-group.js';
import { createProductionToolRegistry } from '../src/agent-gateway/tool-registry.js';

test('本地全链：建 Offer 群、生成 V1、追加讨论后生成 V2', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1")
    .get().project_id;
  const senderId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  const at = '2026-09-10T01:00:00.000Z';
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('binding-e2e','tenant-e2e','mia',?,?,'felix','ACTIVE',?,'test',?,?)`)
    .run('a'.repeat(64), senderId, at, at, at);
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,created_at,updated_at)
    VALUES ('launch-e2e','felix',?,'launch-e2e','READY','READY','oc_source_e2e',?,?)`)
    .run(jobId, at, at);
  setProjectCandidateFocus(db, { tenantId: 'tenant-e2e', consultantId: 'felix', jobId,
    candidateRef: 'TTC-E2E', candidateSnapshot: { name: '测试候选人', role: '算法工程师',
      experience: '8年', city: '上海', education: '硕士',
      evaluation: '大模型经验明确，带队规模待核实', score: '92%' } }, true, at);
  db.prepare(`INSERT INTO lark_messages
    (message_id,chat_id,message_type,text,mentions_json,create_time,received_at)
    VALUES ('source-e2e','oc_source_e2e','text','测试候选人技术能力获得认可','[]',?,?)`)
    .run(at, at);

  const sentCards = [];
  const principal = { tenantId: 'tenant-e2e', consultantId: 'felix', accountId: 'mia', senderId,
    chatType: 'group', chatId: 'oc_source_e2e', purpose: 'candidate_action' };
  const group = await createCandidateDecisionGroup(db, principal,
    { job_id: jobId, candidate_ref: 'TTC-E2E' }, {
      createProjectChat: async (input) => ({ chat_id: 'oc_offer_e2e', name: input.name }),
      ensureOpenClawGroupAllowed: async () => ({ changed: true }),
      sendInteractiveCard: async (input) => { sentCards.push(input); return { message_id: 'om_context' }; },
    });
  assert.equal(group.status, 'READY');
  // 迁移摘要已按小节拆成多个 markdown 元素，动作块不再是固定下标，改为按元素类型定位。
  const contextActions = sentCards[0].card.elements.find((element) => element.tag === 'action').actions;
  assert.deepEqual(contextActions.map((action) => action.text.content),
    ['生成报告', '更新报告', '查看 TTC 人才']);

  const documents = [];
  const registry = createProductionToolRegistry({ db, reportDependencies: {
    createDocumentFn: async (input) => {
      documents.push(input);
      return { document_id: `doc-e2e-${documents.length}`,
        document_url: `https://tenant.feishu.cn/docx/doc-e2e-${documents.length}` };
    },
    sendInteractiveCardFn: async (input) => { sentCards.push(input); return { message_id: 'om_report' }; },
  } });
  const reportContext = { principal: { ...principal, chatId: 'oc_offer_e2e', purpose: 'candidate_review' } };
  const first = await registry.execute('brainx_candidate_report',
    { mode: 'GENERATE', confirm: true }, reportContext);
  assert.equal(first.data.version, 1);
  assert.doesNotMatch(JSON.stringify(documents[0]), /候选人明确接受 400k/);

  const later = '2026-09-10T02:00:00.000Z';
  db.prepare(`INSERT INTO lark_messages
    (message_id,chat_id,message_type,text,mentions_json,create_time,received_at)
    VALUES ('offer-e2e','oc_offer_e2e','text','电话纪要：候选人明确接受 400k，入职日期仍待确认','[]',?,?)`)
    .run(later, later);
  const second = await registry.execute('brainx_candidate_report',
    { mode: 'REGENERATE', confirm: true }, reportContext);
  assert.equal(second.data.version, 2);
  assert.match(JSON.stringify(documents[1]), /候选人明确接受 400k/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_reports WHERE status='READY'").get().n, 2);
  assert.equal(sentCards.filter((item) => item.card.header.title.content.includes('Offer 决策报告')).length, 2);
  db.close();
});
