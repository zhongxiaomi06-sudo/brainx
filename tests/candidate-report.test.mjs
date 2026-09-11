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

test('Offer 决策群报告汇总脱敏证据并按版本更新', async () => {
  const { db, principal } = fixture();
  const documents = [];
  const cards = [];
  const handlers = createCandidateReportToolHandlers({ db,
    createDocumentFn: async (input) => {
      documents.push(input);
      return { document_id: `doc-${documents.length}`,
        document_url: `https://tenant.feishu.cn/docx/doc-${documents.length}` };
    },
    sendInteractiveCardFn: async (input) => { cards.push(input); return { message_id: 'om-report' }; },
  });
  const first = await handlers.brainx_candidate_report({ mode: 'GENERATE', confirm: true }, { principal });
  assert.equal(first.data.version, 1);
  assert.equal(first.data.source_message_count, 1);
  const serialized = JSON.stringify(documents[0]);
  assert.match(serialized, /技术面反馈良好/);
  assert.doesNotMatch(serialized, /13800138000|foo@example\.com/);
  assert.match(serialized, /待确认/);
  assert.equal(cards[0].target, 'oc_offer');
  assert.match(JSON.stringify(cards[0].card), /打开飞书报告/);
  const second = await handlers.brainx_candidate_report({ mode: 'REGENERATE', confirm: true }, { principal });
  assert.equal(second.data.version, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candidate_reports WHERE status='READY'").get().n, 2);
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
