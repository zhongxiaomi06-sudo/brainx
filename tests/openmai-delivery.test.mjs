import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { groupSafeOpenmaiText, deliverOpenmaiResultsOnce } from '../src/openmai-delivery.js';

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
