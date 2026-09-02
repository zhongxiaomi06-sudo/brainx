import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateShortlist, decodeShortlistPageToken } from '../src/candidate-shortlist.js';

const ISO = '2026-09-03T08:00:00.000Z';

function row(rank = 1) {
  return {
    match_run_id: 'run_01', algorithm_version: 'shadow-v1',
    feature_schema_version: 'features-v1', completed_at: ISO,
    candidate_ref: `cand_${rank}`, candidate_name: '张三', match_rank: rank,
    strength_score: 83, job_fit_score: 78, hard_filter_result: 'PASS',
    fact_processed_at: ISO,
    payload_json: JSON.stringify({
      strength_summary: '经历完整且成果有证据', strength_evidence_refs: ['ev_work'],
      job_fit_summary: '行业和投放能力匹配', job_fit_evidence_refs: ['ev_skill'],
      hard_conditions: [{ criterion: '上海办公', result: 'PASS', evidence_refs: ['ev_location'] }],
      gaps: ['薪资未确认'], risks: [], unknowns: ['到岗时间'], freshness_status: 'FRESH',
    }),
  };
}

function reader(rows, capture = []) {
  return (fn) => fn({ execute: async (sql, params) => {
    capture.push({ sql, params });
    return [rows];
  } });
}

test('shortlist：只返回脱敏、已授权、已完成的预计算结果', async () => {
  const calls = [];
  const out = await candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01', limit: 5,
  }, { withConnection: reader([row()], calls) });
  assert.equal(out.items[0].display_name_masked, '张*');
  assert.equal(JSON.stringify(out).includes('张三'), false);
  assert.equal(JSON.stringify(out).includes('13800000000'), false);
  assert.match(calls[0].sql, /mr\.status = 'SUCCEEDED'/);
  assert.match(calls[0].sql, /talent_access_grants/);
  assert.match(calls[0].sql, /job_access_grants/);
  assert.match(calls[0].sql, /tag\.scope = 'resume_facts'/);
  assert.ok(calls[0].params.includes('mia'));
  assert.ok(calls[0].params.includes('tenant_a'));
});

test('shortlist：无职位、无授权和无结果统一为空，不泄露对象是否存在', async () => {
  const out = await candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_missing',
  }, { withConnection: reader([]) });
  assert.deepEqual(out.items, []);
  assert.equal(out.match_run, null);
  assert.equal(out.empty_reason, 'NO_AUTHORIZED_SHORTLIST');
});

test('shortlist：最多 20 条，并用游标锁定同一 match run', async () => {
  const first = await candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01', limit: 20,
  }, { withConnection: reader(Array.from({ length: 20 }, (_, i) => row(i + 1))) });
  assert.ok(first.page.next_page_token);
  assert.deepEqual(decodeShortlistPageToken(first.page.next_page_token), {
    version: 1, match_run_id: 'run_01', after_rank: 20,
  });

  const calls = [];
  await candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01', limit: 5,
    pageToken: first.page.next_page_token,
  }, { withConnection: reader([], calls) });
  assert.match(calls[0].sql, /mr\.match_run_id = \?/);
  assert.ok(calls[0].params.includes('run_01'));
  assert.ok(calls[0].params.includes(20));
});

test('shortlist：非法游标和越界 limit 在查询前失败', async () => {
  let queried = false;
  const withConnection = async () => { queried = true; };
  await assert.rejects(() => candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01', limit: 21,
  }, { withConnection }), /limit/);
  await assert.rejects(() => candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01', pageToken: 'bad-token',
  }, { withConnection }), /page_token/);
  assert.equal(queried, false);
});

test('shortlist：存储 payload 不符合契约时失败关闭，不把原始值带进错误', async () => {
  const bad = row();
  bad.payload_json = JSON.stringify({ phone: '13800000000' });
  await assert.rejects(() => candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01',
  }, { withConnection: reader([bad]) }), (error) => {
    assert.equal(error.code, 'QUALITY_INSUFFICIENT');
    assert.equal(String(error).includes('13800000000'), false);
    return true;
  });
});

test('shortlist：数据库不可用统一为 SOURCE_UNAVAILABLE，不回传底层错误', async () => {
  await assert.rejects(() => candidateShortlist({
    tenantId: 'tenant_a', consultantId: 'mia', jobId: 'job_01',
  }, { withConnection: async () => { throw new Error('SELECT secret FROM private_table'); } }), (error) => {
    assert.equal(error.code, 'SOURCE_UNAVAILABLE');
    assert.equal(String(error).includes('private_table'), false);
    return true;
  });
});
