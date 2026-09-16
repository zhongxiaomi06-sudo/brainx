import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { setProjectCandidateFocus } from '../src/candidate-focus.js';
import { createCandidateReportToolHandlers } from '../src/candidate-report.js';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const at = '2026-09-10T00:00:00.000Z';
  setProjectCandidateFocus(db, { tenantId: 'tenant-a', consultantId: 'felix', jobId,
    candidateRef: 'TTC-100', candidateSnapshot: { name: '张三', role: '算法工程师',
      evaluation: '大模型经验明确，管理范围待核实', score: '90%' } }, true, at);
  db.prepare(`INSERT INTO candidate_decision_groups
    (decision_group_id,tenant_id,position_id,candidate_ref,created_by,source_chat_id,target_chat_id,
     target_chat_name,context_summary,status,created_at,updated_at)
    VALUES ('dg','tenant-a',?,'TTC-100','felix','oc_source','oc_offer','张三-Offer',
      '原项目群讨论：技术能力较强，手机号 13800138000 待确认','READY',?,?)`).run(jobId, at, at);
  db.prepare(`INSERT INTO lark_messages
    (message_id,chat_id,message_type,text,mentions_json,create_time,received_at)
    VALUES ('m1','oc_offer','text','候选人薪酬预期发到 foo@example.com，技术面反馈良好','[]',?,?)`).run(at, at);
  return { db, principal: { tenantId: 'tenant-a', consultantId: 'felix', chatType: 'group',
    chatId: 'oc_offer', purpose: 'candidate_review' } };
}

test('Offer 决策群只创建一份报告，重复生成读取用户编辑稿且不重复发卡', async () => {
  const { db, principal } = fixture();
  const documents = [];
  const cards = [];
  const appends = [];
  let currentText = '用户编辑：最大顾虑是成长空间，电话 13800138000';
  const handlers = createCandidateReportToolHandlers({ db,
    createDocumentFn: async (input) => {
      documents.push(input);
      return { document_id: `doc-${documents.length}`,
        document_url: `https://tenant.feishu.cn/docx/doc-${documents.length}` };
    },
    readDocumentFn: async ({ documentId }) => ({ document_id: documentId, content: currentText }),
    appendDocumentFn: async (input) => { appends.push(input); },
    sendInteractiveCardFn: async (input) => { cards.push(input); return { message_id: 'om-report' }; },
  });
  const first = await handlers.brainx_candidate_report({ mode: 'GENERATE', confirm: true }, { principal });
  assert.equal(first.data.created, true);
  assert.equal(first.data.source_message_count, 1);
  const serialized = JSON.stringify(documents[0]);
  assert.match(serialized, /技术面反馈良好/);
  assert.doesNotMatch(serialized, /13800138000|foo@example\.com/);
  assert.match(serialized, /待确认/);
  assert.equal(cards[0].target, 'oc_offer');
  assert.match(JSON.stringify(cards[0].card), /打开飞书报告/);
  assert.doesNotMatch(JSON.stringify(cards[0].card), /V1/);
  const duplicate = await handlers.brainx_candidate_report({ mode: 'GENERATE', confirm: true }, { principal });
  assert.equal(duplicate.data.already, true);
  assert.match(duplicate.data.report_content, /用户编辑：最大顾虑是成长空间/);
  assert.doesNotMatch(duplicate.data.report_content, /13800138000/);
  const read = await handlers.brainx_candidate_report({ mode: 'READ', confirm: false }, { principal });
  assert.match(read.data.report_content, /成长空间/);
  assert.equal(documents.length, 1);
  assert.equal(cards.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_reports WHERE status='READY'").get().n, 1);

  const later = '2026-09-10T01:00:00.000Z';
  db.prepare(`INSERT INTO lark_messages
    (message_id,chat_id,message_type,text,mentions_json,create_time,received_at)
    VALUES ('m2','oc_offer','text','候选人补充：希望明确晋升标准','[]',?,?)`).run(later, later);
  currentText += '\n候选人补充：希望明确晋升标准';
  const updated = await handlers.brainx_candidate_report({ mode: 'REGENERATE', confirm: true }, { principal });
  assert.equal(updated.data.updated, true);
  assert.equal(appends.length, 1);
  assert.match(JSON.stringify(appends[0].sections), /希望明确晋升标准/);
  assert.equal(documents.length, 1);
  assert.equal(cards.length, 1);
  db.close();
});

test('报告只能从已就绪且匹配租户的候选人决策群生成', async () => {
  const { db, principal } = fixture();
  const handlers = createCandidateReportToolHandlers({ db, createDocumentFn: async () => assert.fail(),
    sendInteractiveCardFn: async () => assert.fail() });
  await assert.rejects(() => handlers.brainx_candidate_report({ mode: 'GENERATE', confirm: true },
    { principal: { ...principal, chatId: 'oc_other' } }), /NOT_FOUND_OR_FORBIDDEN/);
  await assert.rejects(() => handlers.brainx_candidate_report({ mode: 'GENERATE', confirm: false },
    { principal }), /INVALID_ARGUMENT/);
  db.close();
});

test('报告尚未创建时只读返回明确状态，不会偷偷创建文档', async () => {
  const { db, principal } = fixture();
  const handlers = createCandidateReportToolHandlers({ db,
    createDocumentFn: async () => assert.fail('只读不得创建文档'),
    readDocumentFn: async () => assert.fail('没有文档时不得读取'),
    sendInteractiveCardFn: async () => assert.fail('只读不得发卡'),
  });
  const result = await handlers.brainx_candidate_report({ mode: 'READ', confirm: false }, { principal });
  assert.equal(result.data.status, 'NOT_CREATED');
  assert.match(result.unknowns[0], /还没有/);
  db.close();
});
