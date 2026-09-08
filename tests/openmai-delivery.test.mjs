import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import {
  groupSafeOpenmaiText, deliverOpenmaiResultsOnce, extractOpenmaiCandidates, downloadResumePdf,
  buildCandidateTopicCard,
  buildOpenmaiDeliveryCard,
  buildResumeUnavailableCard,
  assessOpenmaiCandidateBatch,
  retryOpenmaiDelivery,
  failStaleOpenmaiTasks,
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

test('OpenMai 群投递：搜索执行人不是建群人时仍回到职位唯一项目群', async () => {
  const db = seededDb();
  db.prepare("UPDATE openmai_results SET consultant_id='mia' WHERE task_id='om_delivery'").run();
  const targets = [];
  const result = await deliverOpenmaiResultsOnce(db, {
    at: now(), publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async ({ target }) => { targets.push(target); return { message_id: 'om_shared' }; },
  });
  assert.equal(result.sent, 1);
  assert.deepEqual(targets, ['oc_delivery']);
  assert.equal(db.prepare('SELECT search_status FROM project_launches').get().search_status, 'DONE');
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

test('OpenMai 结果只有真实送达飞书后才标完成', async () => {
  const db = seededDb();
  const at = now();
  let attempts = 0;
  for (let index = 0; index < 5; index++) {
    db.prepare("UPDATE openmai_deliveries SET next_attempt_at=? WHERE delivery_status='FAILED'").run(at);
    await deliverOpenmaiResultsOnce(db, {
      at, publicBaseUrl: 'https://base.yorkteam.cn/',
      sendInteractiveCard: async () => { attempts++; throw new Error('feishu unavailable'); },
    });
  }
  assert.equal(attempts, 5);
  const launch = db.prepare('SELECT search_status,error_code,error_message FROM project_launches').get();
  assert.equal(launch.search_status, 'FAILED');
  assert.equal(launch.error_code, 'FEISHU_OPENMAI_DELIVERY_FAILED');
  assert.match(launch.error_message, /结果已生成/);
  const retried = retryOpenmaiDelivery(db, 'felix', 'P-DELIVERY', at);
  assert.equal(retried.status, 'delivery_retry');
  assert.deepEqual({ ...db.prepare(`SELECT delivery_status,attempts,last_error
    FROM openmai_deliveries`).get() }, { delivery_status: 'PENDING', attempts: 0, last_error: null });
  db.close();
});

test('OpenMai 服务中断遗留的超时运行任务失败关闭，不自动重复计费', async () => {
  const db = seededDb();
  db.prepare("DELETE FROM openmai_deliveries").run();
  db.prepare(`UPDATE openmai_results SET status='running',result_text=NULL,error=NULL,
    started_at='2026-09-07T10:00:00.000Z',finished_at=NULL WHERE task_id='om_delivery'`).run();
  assert.equal(failStaleOpenmaiTasks(db, '2026-09-07T11:00:01.000Z'), 1);
  const row = db.prepare(`SELECT status,error,finished_at,task_id FROM openmai_results`).get();
  assert.equal(row.status, 'failed');
  assert.equal(row.task_id, 'om_delivery');
  assert.match(row.error, /避免重复费用.*明确重试/);
  assert.equal(row.finished_at, '2026-09-07T11:00:01.000Z');
  assert.equal(failStaleOpenmaiTasks(db, '2026-09-07T12:00:01.000Z'), 0);
  db.close();
});

test('OpenMai 仍在最大执行窗口内的任务不会被 worker 误判', () => {
  const db = seededDb();
  db.prepare(`UPDATE openmai_results SET status='running',result_text=NULL,
    started_at='2026-09-07T10:00:00.000Z',finished_at=NULL WHERE task_id='om_delivery'`).run();
  assert.equal(failStaleOpenmaiTasks(db, '2026-09-07T10:59:59.000Z'), 0);
  assert.equal(db.prepare('SELECT status FROM openmai_results').get().status, 'running');
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

test('OpenMai 结构化候选少于 6 人时显式标记不足，历史无机器块结果保持兼容', () => {
  const partial = `候选摘要\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'c-1', name: '张三', evaluation: '匹配', resume_url: null },
  ] })}\n-->`;
  assert.deepEqual(assessOpenmaiCandidateBatch(partial), {
    count: 1, hasMachineBlock: true, complete: false,
    message: 'OpenMai 本轮仅返回 1 名结构化候选人，未达到首轮 6–10 人目标；已保留现有结果，请明确重试补充。',
  });
  assert.equal(assessOpenmaiCandidateBatch('历史候选结果').complete, true);
});

test('OpenMai 总览使用整洁双列表格且末尾只有一个操作按钮', () => {
  const resultText = `不应把这段 Markdown 原文直接发群\n|姓名|详情|\n|---|---|\n<!-- BRAINX_CANDIDATES_V1
${JSON.stringify({ candidates: [
    { candidate_ref: 'c-1', name: '张三', evaluation: '匹配 91%，驱动经验待核实', resume_url: null },
    { candidate_ref: 'c-2', name: '李四', evaluation: '匹配 86%，地点待核实', resume_url: null },
  ] })}
-->`;
  const card = buildOpenmaiDeliveryCard({ job: { project_id: 'P-DELIVERY', company: '甲公司', role: '研发负责人' },
    status: 'done', resultText, publicBaseUrl: 'https://base.yorkteam.cn/' });
  const rows = card.elements.filter((element) => element.tag === 'column_set');
  assert.equal(rows.length, 3, '一行表头加两行候选人');
  assert.equal(rows[0].columns[0].elements[0].text.content, '候选人');
  assert.equal(rows[1].columns[0].elements[0].text.content, '1. 张三');
  assert.match(rows[1].columns[1].elements[0].text.content, /91%/);
  assert.doesNotMatch(JSON.stringify(card), /\|姓名\|详情\||不应把这段/);
  const actions = card.elements.filter((element) => element.tag === 'action');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].actions.length, 1);
  assert.equal(actions[0].actions[0].text.content, '打开工作台查看与评估');
  assert.equal(card.elements.at(-2).tag, 'action');
});

test('OpenMai 候选不足仍投递已有结果，并把项目置为明确可重试状态', async () => {
  const db = seededDb();
  const partial = `候选摘要\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'c-1', name: '张三', evaluation: '匹配', resume_url: null },
  ] })}\n-->`;
  db.prepare("UPDATE openmai_results SET result_text=? WHERE task_id='om_delivery'").run(partial);
  const cards = [];
  const out = await deliverOpenmaiResultsOnce(db, {
    at: now(), publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async (input) => { cards.push(input); return { message_id: `om_${cards.length}` }; },
  });
  assert.equal(out.sent, 1);
  assert.equal(cards.length, 1, '无真实 PDF 时只投递一张整洁总览卡');
  assert.equal(cards[0].card.header.template, 'orange');
  assert.match(cards[0].card.header.title.content, /候选人不足/);
  assert.match(cards[0].card.elements[0].content, /仅返回 1 名/);
  const launch = db.prepare('SELECT search_status,error_code,error_message FROM project_launches').get();
  assert.equal(launch.search_status, 'FAILED');
  assert.equal(launch.error_code, 'OPENMAI_CANDIDATES_INCOMPLETE');
  assert.match(launch.error_message, /明确重试/);
  db.close();
});

test('候选人话题卡把评估、工作台入口和附件状态放在同一协作单元', () => {
  const card = buildCandidateTopicCard({
    candidate: { candidateRef: 'c-1', name: '张三', evaluation: '匹配 86%，邮箱 a@example.com',
      resumeUrl: 'https://gateway.ttcadvisory.com/resume/c-1.pdf' },
    job: { project_id: 'P-DELIVERY' }, publicBaseUrl: 'https://base.yorkteam.cn/',
  });
  assert.match(card.header.title.content, /张三/);
  assert.match(card.elements[0].content, /候选编号：c-1/);
  assert.doesNotMatch(card.elements[0].content, /a@example\.com/);
  assert.match(card.elements[2].elements[0].content, /PDF 简历将回复在本话题/);
  const target = new URL(card.elements[1].actions[0].multi_url.url);
  assert.equal(target.searchParams.get('candidate'), 'c-1');
});

test('单份简历异常卡不暴露底层错误并保留候选人评估', () => {
  const card = buildResumeUnavailableCard({ name: '李四 13900139000' });
  assert.doesNotMatch(JSON.stringify(card), /13900139000|RESUME_|HTTP/);
  assert.match(JSON.stringify(card), /不会阻断其他候选人投递/);
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

test('一名候选人 PDF 校验失败只在本话题告警，后续候选仍正常投递', async () => {
  const db = seededDb();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'c-bad', name: '甲', evaluation: '待核实', resume_url: 'https://gateway.ttcadvisory.com/resumes/bad.pdf' },
    { candidate_ref: 'c-good', name: '乙', evaluation: '匹配', resume_url: 'https://gateway.ttcadvisory.com/resumes/good.pdf' },
  ] })}\n-->`;
  db.prepare("UPDATE openmai_results SET result_text=? WHERE task_id='om_delivery'").run(resultText);
  saveTtcToken(db, 'felix', 'header.payload.signature', {
    userName: 'Felix', personId: 'p-1', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let cardCount = 0;
  const files = [];
  const warnings = [];
  const out = await deliverOpenmaiResultsOnce(db, {
    at: now(), publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async () => ({ message_id: `om_card_${++cardCount}` }),
    fetchImpl: async (url) => new Response(url.toString().includes('/bad.pdf')
      ? Buffer.from('not a pdf') : Buffer.from('%PDF-1.7 good'), { status: 200 }),
    sendPdfFile: async (input) => { files.push(input); return { message_id: 'om_pdf' }; },
    replyInteractiveCard: async (input) => { warnings.push(input); return { message_id: 'om_warning' }; },
  });
  assert.equal(out.sent, 1);
  assert.equal(cardCount, 3, '一张整批卡加两张候选卡');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].messageId, 'om_card_2');
  assert.match(warnings[0].idempotencyKey, /resume-warning-1$/);
  assert.equal(files.length, 1);
  assert.equal(files[0].fileName, '乙-简历.pdf');
  assert.equal(files[0].replyToMessageId, 'om_card_3');
  db.close();
});

test('简历网络故障不伪装成永久缺失，整批保留恢复性重试', async () => {
  const db = seededDb();
  const resultText = `候选结果\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates: [
    { candidate_ref: 'c-retry', name: '丙', evaluation: '匹配', resume_url: 'https://gateway.ttcadvisory.com/resumes/retry.pdf' },
  ] })}\n-->`;
  db.prepare("UPDATE openmai_results SET result_text=? WHERE task_id='om_delivery'").run(resultText);
  saveTtcToken(db, 'felix', 'header.payload.signature', {
    userName: 'Felix', personId: 'p-1', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  let warned = false;
  const out = await deliverOpenmaiResultsOnce(db, {
    at: now(), publicBaseUrl: 'https://base.yorkteam.cn/',
    sendInteractiveCard: async () => ({ message_id: 'om_retry_topic' }),
    fetchImpl: async () => new Response('upstream unavailable', { status: 503 }),
    replyInteractiveCard: async () => { warned = true; },
  });
  assert.equal(out.failed, 1);
  assert.equal(warned, false);
  assert.equal(db.prepare('SELECT delivery_status FROM openmai_deliveries').get().delivery_status, 'FAILED');
  db.close();
});
