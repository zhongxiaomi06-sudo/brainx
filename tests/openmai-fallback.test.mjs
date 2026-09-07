/** openmai-fallback.test.mjs — 凭证兜底链回归：接单人无 TTC JWT 时借用名单内有效凭证代执行，
 * 结果标注凭证来源；全员无凭证保持原失败语义（2026-09-07）。 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { resolveTtcJwtWithFallback, startOpenmaiTask, getOpenmaiResult } from '../src/openmai-task.js';
import { saveTtcToken, validateJwt } from '../src/ttcsdk/auth.js';

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = () => `${b64url({ alg: 'none' })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600, name: '测试' })}.sig`;

let db;
const PID = 'JFB01';

before(() => {
  db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  // 待测职位：source_url 无 ttc:// 真身 → realId 走 project_id（stub fetch 不关心）
  const syncId = db.prepare('SELECT sync_id FROM sync_runs LIMIT 1').get().sync_id;
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO job_facts (project_id, company, role, active_state, captured_at, sync_id, raw_json, updated_at)
    VALUES (?, '兜底测试公司', '找人测试岗', 'OPEN', ?, ?, '{}', ?)`).run(PID, ts, syncId, ts);
});

test('resolveTtcJwtWithFallback：本人有凭证直接用，不借用', () => {
  const resolver = (_db, cid) => (cid === 'york' ? 'jwt-york' : null);
  const r = resolveTtcJwtWithFallback({}, 'york', { resolver });
  assert.deepEqual(r, { jwt: 'jwt-york', delegate: null });
});

test('resolveTtcJwtWithFallback：本人无凭证 → 按名单借用第一个有效的，并跳过本人', () => {
  const resolver = (_db, cid) => (cid === 'felix' ? 'jwt-felix' : null);
  const r = resolveTtcJwtWithFallback({}, 'york', { resolver });
  assert.deepEqual(r, { jwt: 'jwt-felix', delegate: 'felix' });
  // 名单里本人排在前面也不能自己借给自己（felix 无凭证、mia 有 → 借 mia）
  const r2 = resolveTtcJwtWithFallback({}, 'felix', { resolver: (_db, cid) => (cid === 'mia' ? 'jwt-mia' : null) });
  assert.deepEqual(r2, { jwt: 'jwt-mia', delegate: 'mia' });
});

test('resolveTtcJwtWithFallback：全员无凭证 → null（保持失败语义）', () => {
  const r = resolveTtcJwtWithFallback({}, 'york', { resolver: () => null });
  assert.deepEqual(r, { jwt: null, delegate: null });
});

test('startOpenmaiTask 兜底链 E2E：york 无凭证 → 借 felix 执行 → done 且结果标注代执行', async () => {
  const jwt = fakeJwt();
  saveTtcToken(db, 'felix', jwt, validateJwt(jwt));
  assert.equal(getOpenmaiResult(db, 'york', PID).status, 'none');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/crm/v1/openmai/jobs/detail')) {
      return new Response(JSON.stringify({ code: 0, data: { jobs: [{ unique_id: PID, name: '找人测试岗' }] } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // OpenMai completions：SSE 立即完成
    const sse = [
      'data: {"type":"session_created","session_id":"s1"}',
      '',
      'data: {"done":true,"message_id":"m1","canonical_content":"候选人A、候选人B"}',
      '',
      '',
    ].join('\n');
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close(); },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  try {
    const r = startOpenmaiTask(db, null, 'york', PID);
    assert.equal(r.status, 'triggered');
    assert.equal(r.delegate, 'felix');
    // 等异步任务收尾
    for (let i = 0; i < 30 && getOpenmaiResult(db, 'york', PID).status === 'running'; i++) {
      await new Promise((res) => setTimeout(res, 100));
    }
    const out = getOpenmaiResult(db, 'york', PID);
    assert.equal(out.status, 'done', `E2E 失败详情: ${out.error}`);
    assert.ok(out.result_text.startsWith('【凭证代执行：felix】'), '结果必须标注凭证来源');
    assert.ok(out.result_text.includes('候选人A、候选人B'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('startOpenmaiTask：全员无凭证 → failed 且错误语义不变', async () => {
  const dbx = openDb(':memory:');
  runSync(dbx, { source: 'fixture', consultant_id: 'felix' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('不应发起网络请求'); };
  try {
    const r = startOpenmaiTask(dbx, null, 'york', 'P-FIX-6FFEA4D1');
    assert.equal(r.status, 'error');
    assert.match(r.message, /没有有效 TTC 凭证/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
