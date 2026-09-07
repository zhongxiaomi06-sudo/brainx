import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import {
  groupSafeOpenmaiText, deliverOpenmaiResultsOnce, extractOpenmaiCandidates, downloadResumePdf,
  buildCandidateTopicCard,
} from '../src/openmai-delivery.js';
import { buildPrompt } from '../src/openmai-task.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';

function seededDb(status = 'done') {
  const db = openDb(':memory:');
  const at = now();
  db.prepare(`INSERT INTO sync_runs
    (sync_id,consultant_id,source,as_of,rows_expected,rows_read,complete,errors,input_hash,started_at,completed_at)
    VALUES ('sync-delivery','felix','test',?,1,1,1,'[]','hash',?,?)`).run(at, at, at);
  db.prepare(`INSERT INTO job_facts
    (project_id,company,role,active_state,captured_at,sync_id,raw_json,updated_at)
    VALUES ('P-DELIVERY','候选公司','研发负责人','OPEN',?,'sync-delivery','{}',?)`).run(at, at);
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,created_at,updated_at)
    VALUES ('launch-delivery','felix','P-DELIVERY','launch-key','READY','READY','oc_delivery',?,?)`).run(at, at);
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,error,task_id,started_at,finished_at)
    VALUES ('P-DELIVERY','felix',?,?,?,?,?,?)`).run(
      status,
      status === 'done' ? '候选人 A｜13800138000｜a@example.com｜匹配度 86%｜[简历](https://example.com/resume)' : null,
      status === 'failed' ? '上游暂时不可用' : null,
      'om_delivery', at, at,
    );
  return db;
}

test('OpenMai 群投递：候选结果脱敏后只发送一次并更新项目状态', async () => {
  const db = seededDb();
  const calls = [];
  const dependencies = {
    at: now(), publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async (input) => { calls.push(input); return { message_id: 'om_sent' }; },
  };
  const first = await deliverOpenmaiResultsOnce(db, dependencies);
  assert.deepEqual(first, { enqueued: 1, attempted: 1, sent: 1, failed: 0 });
  const content = calls[0].card.elements[0].content;
  assert.doesNotMatch(content, /13800138000|a@example\.com/);
  assert.match(content, /简历/);
  assert.equal(db.prepare('SELECT delivery_status FROM openmai_deliveries').get().delivery_status, 'SENT');
  assert.equal(db.prepare('SELECT search_status FROM project_launches').get().search_status, 'DONE');
  const duplicate = await deliverOpenmaiResultsOnce(db, dependencies);
  assert.deepEqual(duplicate, { enqueued: 0, attempted: 0, sent: 0, failed: 0 });
  assert.equal(calls.length, 1);
  db.close();
});

test('OpenMai 群投递：发送失败进入有限重试而不是丢结果', async () => {
  const db = seededDb('failed');
  const at = now();
  const result = await deliverOpenmaiResultsOnce(db, {
    at, publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async () => { throw new Error('network'); },
  });
  assert.equal(result.failed, 1);
  const row = db.prepare('SELECT * FROM openmai_deliveries').get();
  assert.equal(row.delivery_status, 'FAILED');
  assert.equal(row.attempts, 1);
  assert.equal(Date.parse(row.next_attempt_at) > Date.parse(at), true);
  assert.equal(db.prepare('SELECT search_status FROM project_launches').get().search_status, 'FAILED');
  db.close();
});

test('OpenMai 群投递：长文本、HTML 注释和联系方式按群边界清理', () => {
  const safe = groupSafeOpenmaiText(`<!--hidden-->张三 13900139000 foo@bar.com ${'结果'.repeat(4000)}`);
  assert.doesNotMatch(safe, /hidden|13900139000|foo@bar\.com/);
  assert.match(safe, /完整结果请在工作台查看/);
  assert.equal(safe.length < 6700, true);
});

test('OpenMai 提示要求 6-10 人、逐人评估和真实 PDF，机器块可安全解析', () => {
  const prompt = buildPrompt({ unique_id: 'J1', name: '产品负责人', cities: ['上海'] });
  assert.match(prompt, /6-10 名/);
  assert.match(prompt, /推荐理由、风险或待核实项/);
  assert.match(prompt, /不得编造链接/);
  const text = `候选摘要\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'c-1', name: '张三', evaluation: '匹配', resume_url: 'https://gateway.ttcadvisory.com/resume/c-1.pdf' },
  ] })}\n-->`;
  assert.deepEqual(extractOpenmaiCandidates(text), [{ candidateRef: 'c-1', name: '张三',
    evaluation: '匹配', resumeUrl: 'https://gateway.ttcadvisory.com/resume/c-1.pdf' }]);
  assert.doesNotMatch(groupSafeOpenmaiText(text), /BRAINX_CANDIDATES|resume\/c-1/);
});

test('候选人话题卡把评估、工作台入口和附件状态放在同一协作单元', () => {
  const card = buildCandidateTopicCard({
    candidate: { candidateRef: 'c-1', name: '张三', evaluation: '匹配 86%，邮箱 a@example.com',
      resumeUrl: 'https://gateway.ttcadvisory.com/resume/c-1.pdf' },
    job: { project_id: 'P-DELIVERY' }, publicBaseUrl: 'https://base.yorkteam.cn/',
  });
  assert.match(card.header.title.content, /张三/);
  assert.doesNotMatch(card.elements[0].content, /a@example\.com/);
  assert.match(card.elements[2].elements[0].content, /PDF 简历将回复在本话题/);
  const target = new URL(card.elements[1].actions[0].multi_url.url);
  assert.equal(target.searchParams.get('candidate'), 'c-1');
});

test('简历下载只接受受信 HTTPS 域、限制大小并验证 PDF 内容', async () => {
  const pdf = await downloadResumePdf('https://gateway.ttcadvisory.com/resume/1.pdf', 'jwt-test', {
    fetchImpl: async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer jwt-test');
      return new Response(Buffer.from('%PDF-1.7 safe'), { status: 200,
        headers: { 'content-type': 'application/pdf' } });
    },
  });
  assert.match(pdf.toString(), /^%PDF-/);
  await assert.rejects(downloadResumePdf('https://evil.example/resume.pdf', 'jwt-test'),
    /RESUME_URL_NOT_TRUSTED/);
  await assert.rejects(downloadResumePdf('http://gateway.ttcadvisory.com/resume.pdf', 'jwt-test'),
    /RESUME_URL_NOT_TRUSTED/);
});

test('OpenMai 成功投递为每名候选人建独立话题并把真实 PDF 回复进对应话题', async () => {
  const db = seededDb();
  const resultText = `候选人张三：匹配\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'c-1', name: '张三', evaluation: '匹配', resume_url: 'https://gateway.ttcadvisory.com/resumes/c-1.pdf' },
  ] })}\n-->`;
  db.prepare("UPDATE openmai_results SET result_text=? WHERE task_id='om_delivery'").run(resultText);
  saveTtcToken(db, 'felix', 'header.payload.signature', {
    userName: 'Felix', personId: 'p-1', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const cards = [];
  const files = [];
  const result = await deliverOpenmaiResultsOnce(db, {
    at: now(), publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async (input) => {
      cards.push(input);
      return { message_id: cards.length === 1 ? 'om_summary' : 'om_candidate' };
    },
    fetchImpl: async () => new Response(Buffer.from('%PDF-1.7 resume'), { status: 200 }),
    sendPdfFile: async (input) => { files.push(input); return { message_id: 'om_pdf' }; },
  });
  assert.equal(result.sent, 1);
  assert.equal(cards.length, 2);
  assert.match(cards[1].idempotencyKey, /candidate-1$/);
  assert.match(cards[1].card.elements[0].content, /匹配/);
  assert.equal(files.length, 1);
  assert.equal(files[0].target, 'oc_delivery');
  assert.equal(files[0].fileName, '张三-简历.pdf');
  assert.match(files[0].data.toString(), /^%PDF-/);
  assert.match(files[0].idempotencyKey, /resume-1$/);
  assert.equal(files[0].replyToMessageId, 'om_candidate');
  db.close();
});
