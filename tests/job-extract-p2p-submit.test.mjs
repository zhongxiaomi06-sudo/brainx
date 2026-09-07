import test from 'node:test';
import assert from 'node:assert/strict';

// 强制规则层路径：测试不依赖任何真实 LLM 配置（BRAINX_LLM_DISABLE=1 运行时硬关）
process.env.BRAINX_LLM_DISABLE = '1';
delete process.env.AI_JOB_EXTRACT_ENABLED;

import { openDb } from '../src/db.js';
import { submitPrivateJd, jdMessageId } from '../src/job-extract/p2p-submit.js';
import { createJdSubmitToolHandlers } from '../src/agent-gateway/tools-jd-submit.js';
import { createJobFactsToolHandlers } from '../src/agent-gateway/tools-job-facts.js';
import { AGENT_TOOL_ROWS } from '../src/agent-gateway/tool-registry.js';

const JD_TEXT = '星曜科技有限公司急招后端工程师，base 上海，HC 3，团队负责交易系统核心链路，'
  + '要求三年以上 Java 或 Go 服务端经验，熟悉高并发与分布式事务，能接受偶尔出差客户现场。';

function principal(consultantId) {
  return { consultantId, tenantId: 'tenant-a', accountId: 'braintex-prod', chatType: 'p2p', chatId: `ou_${consultantId}` };
}

test('registry 声明 brainx_submit_job_jd：p2p-only、jd_text 上限 8000、confirm 必填', () => {
  const row = AGENT_TOOL_ROWS.find((r) => r.name === 'brainx_submit_job_jd');
  assert.ok(row, 'registry 缺少 brainx_submit_job_jd');
  assert.equal(row.p2pOnly, true);
  assert.deepEqual(row.purpose, ['job_fact_review']);
  assert.equal(row.parameters.properties.jd_text.maxLength, 8000);
  assert.deepEqual(row.parameters.required, ['jd_text', 'confirm']);
});

test('规则层提交：产出 origin=p2p_jd 草稿，带字段与原文证据', async () => {
  const db = openDb(':memory:');
  const r = await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: JD_TEXT });
  assert.equal(r.duplicate, false);
  assert.equal(r.action, 'extracted');
  assert.equal(r.layer, 'rules');

  const draft = db.prepare('SELECT * FROM job_facts_drafts WHERE draft_id=?').get(r.draft_id);
  assert.equal(draft.origin, 'p2p_jd');
  assert.equal(draft.submitted_by, 'mia');
  assert.equal(draft.status, 'pending');
  assert.equal(draft.company, '星曜科技有限公司');
  assert.equal(draft.role, '后端工程师');
  assert.equal(draft.city, '上海');
  assert.equal(draft.hc, 3);
  // 原文全文入 lark_messages 作证据，正文不入账本 payload
  const msg = db.prepare('SELECT text FROM lark_messages WHERE message_id=?').get(r.message_id);
  assert.equal(msg.text, JD_TEXT);
  const ev = db.prepare('SELECT payload FROM workflow_event_log WHERE idem_key=?')
    .get(`lark.message_received:${r.message_id}`);
  assert.ok(!JSON.parse(ev.payload).text);
});

test('同一顾问重复提交同一段 JD：幂等短路返回既有草稿，不产生第二条', async () => {
  const db = openDb(':memory:');
  const first = await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: JD_TEXT });
  for (let i = 0; i < 3; i++) {
    const again = await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: JD_TEXT });
    assert.equal(again.duplicate, true);
    assert.equal(again.draft.draft_id, first.draft_id);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lark_messages').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM workflow_event_log').get().n, 1);
});

test('不同顾问提交同一段 JD：各自成草稿，互不短路', async () => {
  const db = openDb(':memory:');
  const mia = await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: JD_TEXT });
  const felix = await submitPrivateJd(db, { consultant_id: 'felix', chat_id: 'ou_felix', text: JD_TEXT });
  assert.notEqual(mia.draft_id, felix.draft_id);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 2);
});

test('JD 不足 50 字：拒绝且无副作用', async () => {
  const db = openDb(':memory:');
  await assert.rejects(
    () => submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: '招前端' }),
    /JD_TOO_SHORT/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 0);
});

test('jdMessageId 含 consultant_id：跨人不同 id，同人同文稳定', () => {
  assert.equal(jdMessageId('mia', 'X'.repeat(60)), jdMessageId('mia', 'X'.repeat(60)));
  assert.notEqual(jdMessageId('mia', 'X'.repeat(60)), jdMessageId('felix', 'X'.repeat(60)));
});

test('私聊 JD 草稿仅提交人可见：他人列表看不到、裁决默认拒绝', async () => {
  const db = openDb(':memory:');
  await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: JD_TEXT });
  const tools = createJobFactsToolHandlers({ db });

  const mine = tools.brainx_pending_job_facts({ limit: 20 }, { principal: principal('mia') });
  assert.equal(mine.data.items.length, 1);
  assert.equal(mine.data.items[0].source, 'rules');

  const others = tools.brainx_pending_job_facts({ limit: 20 }, { principal: principal('felix') });
  assert.equal(others.data.items.length, 0);
  assert.throws(
    () => tools.brainx_review_job_fact(
      { draft_id: mine.data.items[0].draft_ref, action: 'confirm', confirm: true },
      { principal: principal('felix') },
    ),
    /NOT_FOUND_OR_FORBIDDEN/,
  );
});

test('提交人确认 JD 草稿 → 职位权威事实转正，可被接单链路读取', async () => {
  const db = openDb(':memory:');
  const submitted = await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text: JD_TEXT });
  const factsTools = createJobFactsToolHandlers({ db });
  const submitTools = createJdSubmitToolHandlers({ db });

  const confirm = factsTools.brainx_review_job_fact(
    { draft_id: submitted.draft_id, action: 'confirm', confirm: true },
    { principal: principal('mia') },
  );
  assert.equal(confirm.data.status, 'confirmed');
  assert.ok(confirm.data.job_ref);
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(confirm.data.job_ref);
  assert.equal(job.company, '星曜科技有限公司');
  assert.equal(job.role, '后端工程师');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM job_memberships WHERE consultant_id='mia' AND project_id=?")
    .get(confirm.data.job_ref).n, 1);
  // 重复确认幂等：返回 already，不重复写入
  const again = factsTools.brainx_review_job_fact(
    { draft_id: submitted.draft_id, action: 'confirm', confirm: true },
    { principal: principal('mia') },
  );
  assert.equal(again.data.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts').get().n, 1);
  assert.ok(submitTools.brainx_submit_job_jd); // handler 已注册（烟测）
});

test('handler：confirm 缺失/为 false 时拒绝，不触达提交逻辑', async () => {
  const db = openDb(':memory:');
  const tools = createJdSubmitToolHandlers({ db });
  await assert.rejects(
    () => tools.brainx_submit_job_jd({ jd_text: JD_TEXT, confirm: false }, { principal: principal('mia') }),
    /INVALID_ARGUMENT/,
  );
  await assert.rejects(
    () => tools.brainx_submit_job_jd({ jd_text: JD_TEXT }, { principal: principal('mia') }),
    /INVALID_ARGUMENT/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 0);
});

test('规则层提不出任何有效字段：不产空草稿，返回可区分结果', async () => {
  const db = openDb(':memory:');
  const text = '今天天气不错，适合出去走走，顺便聊聊最近看的书和电影，心情很好，'
    + '晚上打算尝试一家新的餐厅，据说那边的甜品非常有名，值得一试。';
  const r = await submitPrivateJd(db, { consultant_id: 'mia', chat_id: 'ou_mia', text });
  assert.equal(r.action, 'no_fields');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 0);
});
