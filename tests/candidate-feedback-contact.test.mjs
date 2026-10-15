import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createCandidateActionToolHandlers } from '../src/agent-gateway/tools-candidate-actions.js';
import { nextSearchExclusions, nextSupermaiSearchExclusions } from '../src/search-rounds.js';
import { sendCandidatePrivateContact } from '../src/agent-gateway/candidate-private-contact.js';
import { assertSafeAgentProjection } from '../src/agent-gateway/projection.js';
import { rejectCandidateAction } from '../src/candidate-card-actions.js';
import { readTtcResumeContact, extractResumeContact, pdfTextInMemory } from '../src/candidate-contact-resume.js';
import { readCandidateContactCache } from '../src/candidate-contact-cache.js';
import { candidateDecisionCard } from '../src/candidate-decision-card.js';
import { normalizeExcludedCandidateRefs } from '../src/search-rounds.js';

const principal = { tenantId: 't1', consultantId: 'felix', accountId: 'a1', senderId: 'ou_me', chatType: 'group', chatId: 'oc_group' };
function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jobId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  const handlers = createCandidateActionToolHandlers({ db, candidateShortlistFn: async () => ({
    items: [{ candidate_ref: 'PL1234567890' }], page: { next_page_token: null },
  }) });
  return { db, jobId, act: (action, confirm = true) => handlers.brainx_candidate_workflow({
    job_id: jobId, candidate_ref: 'PL1234567890', action, confirm, note: '技能不匹配',
  }, { principal }) };
}

test('拒绝需确认，重复幂等、个人项目隔离、撤销可回放', async t => {
  const { db, jobId, act } = fixture(t);
  await assert.rejects(() => act('REJECT_CANDIDATE', false), /INVALID_ARGUMENT/);
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_search_feedback_events').get().n, 0);
  await act('REJECT_CANDIDATE');
  await act('REJECT_CANDIDATE');
  for (const select of [nextSearchExclusions, nextSupermaiSearchExclusions]) {
    assert.deepEqual(select(db, jobId, principal), ['PL1234567890']);
    assert.deepEqual(select(db, jobId, { ...principal, tenantId: 't2' }), []);
    assert.deepEqual(select(db, jobId, { ...principal, consultantId: 'mia' }), []);
    assert.deepEqual(select(db, 'other', principal), ['PL1234567890']);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_search_feedback_events').get().n, 1);
  await act('RESTORE_CANDIDATE');
  assert.deepEqual(nextSearchExclusions(db, jobId, principal), []);
  assert.deepEqual(nextSupermaiSearchExclusions(db, 'supermai:0123456789ab', principal), []);
  assert.equal(db.prepare('SELECT count(*) n FROM candidate_search_feedback_events').get().n, 2);
});

test('不合适按钮声明二次确认，取消不会携带写操作', () => {
  const button = rejectCandidateAction({ project_id: 'P1' }, { candidateRef: 'PL1234567890' });
  assert.match(button.confirm.title.content, /确认/);
  assert.match(button.value.text, /REJECT_CANDIDATE/);
  assert.match(button.confirm.text.content, /长期排除/);
  const followup = candidateDecisionCard({ name: '测试人选', status: 'REJECTED',
    jobId: 'P1', candidateRef: 'PL1234567890' });
  assert.match(JSON.stringify(followup), /撤销排除|RESTORE_CANDIDATE/);
  assert.doesNotMatch(JSON.stringify(followup), /电话|邮箱/);
});

test('排除名单超过外部引擎上限时拒绝付费搜索而非静默截断', () => {
  assert.throws(() => normalizeExcludedCandidateRefs(Array.from({ length: 101 }, (_, i) => `PL${i}`)),
    /SEARCH_EXCLUSIONS_OVER_LIMIT/);
});

const keyHash = createHash('sha256').update('test_app_key').digest('hex');
const wrongKeyHash = createHash('sha256').update('wrong_app_key').digest('hex');
function binding(db) {
  const at = now();
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
    binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('b','t1','a1',?,'ou_me','felix','ACTIVE',?,'test',?,?)`)
    .run(keyHash, at, at, at);
}
test('联系方式只私发可信发起人，不回群或工具返回；发送失败不假称送达', async t => {
  const { db } = fixture(t);
  binding(db);
  const sent = [];
  const deps = { appKeyHash: keyHash, getTtcJwtFn: () => 'own-jwt', loadCandidateContactFn: async input => {
    assert.equal(input.tenantId, 't1'); assert.equal(input.consultantId, 'felix');
    return { phone: '13812345678', email: 'example@example.com' };
  }, sendTextMessageFn: async input => { sent.push(input); } };
  const out = await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps);
  assert.equal(out.data.delivery_status, 'sent');
  // 回归：群聊投影安全不允许结果里出现 contact* key（曾名 contact_delivery 导致群内 INTERNAL）。
  assert.doesNotThrow(() => assertSafeAgentProjection(out, principal));
  assert.equal(Object.keys(out.data).some(k => /contact/i.test(k)), false);
  assert.equal(sent[0].target, 'ou_me');
  assert.match(sent[0].text, /13812345678/);
  assert.doesNotMatch(JSON.stringify(out), /13812345678|example@example/);
  const failed = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, sendTextMessageFn: async () => { throw new Error('private secret'); },
  });
  assert.equal(failed.data.delivery_status, 'fetch_failed');
  assert.doesNotMatch(JSON.stringify(failed), /private secret|13812345678/);
});
test('撤权或应用不匹配时不读取；无电话与无授权区分', async t => {
  const { db } = fixture(t);
  binding(db);
  const deps = { appKeyHash: wrongKeyHash, loadCandidateContactFn: async () => assert.fail('不能读取'),
    sendTextMessageFn: async () => assert.fail('不能发送') };
  assert.equal((await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps)).data.delivery_status, 'fetch_failed');
  const pending = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash, loadCandidateContactFn: async () => ({ phone: null, email: null }),
  });
  assert.equal(pending.data.delivery_status, 'credential_expired');
  const denied = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash, poolCheckFn: async () => null,
    loadCandidateContactFn: async () => {
      throw Object.assign(new Error('NOT_FOUND_OR_FORBIDDEN'), { code: 'NOT_FOUND_OR_FORBIDDEN' });
    },
  });
  assert.equal(denied.data.delivery_status, 'credential_expired');
  assert.match(denied.recommendations[0].note, /凭证失效/);
  const inPool = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash, getTtcJwtFn: () => 'own-jwt',
    readResumeFn: async () => ({ status: 'no_resume' }), poolCheckFn: async () => 405,
    loadCandidateContactFn: async () => {
      throw Object.assign(new Error('NOT_FOUND_OR_FORBIDDEN'), { code: 'NOT_FOUND_OR_FORBIDDEN' });
    },
  });
  assert.equal(inPool.data.delivery_status, 'in_pool_pending_match');
  assert.match(inPool.recommendations[0].note, /待撞库/);
  assert.doesNotThrow(() => assertSafeAgentProjection(inPool, principal));
  db.exec("UPDATE feishu_identity_bindings SET binding_status='REVOKED'");
  assert.equal((await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, appKeyHash: keyHash,
  })).data.delivery_status, 'fetch_failed');
});

test('本人 TTC 首次解析、30 天缓存命中、过期重拉，群投影无敏感字段', async t => {
  const { db } = fixture(t); binding(db);
  let calls = 0;
  const sent = [];
  const deps = { appKeyHash: keyHash, getTtcJwtFn: () => 'own-jwt',
    loadCandidateContactFn: async () => { throw Object.assign(new Error(), { code: 'NOT_FOUND_OR_FORBIDDEN' }); },
    readResumeFn: async (_ref, jwt) => { assert.equal(jwt, 'own-jwt'); calls += 1;
      return { status: 'found', phone: '13812345678', email: null, source: 'ttc_resume' }; },
    sendTextMessageFn: async (input) => { sent.push(input); } };
  const first = await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps);
  assert.equal(first.data.delivery_status, 'sent');
  assert.doesNotThrow(() => assertSafeAgentProjection(first, principal));
  assert.doesNotMatch(JSON.stringify(first), /13812345678/);
  assert.doesNotMatch(db.prepare(`SELECT content_json FROM context_registry_entries
    WHERE source_type='candidate_contact_cache'`).get().content_json, /13812345678/);
  await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps);
  assert.equal(calls, 1); assert.equal(sent.length, 2);
  assert.match(sent[1].text, /13812345678/);
  assert.equal(readCandidateContactCache(db, principal, 'PL1234567890',
    new Date(Date.now() + 31 * 24 * 3600_000)), null);
  db.exec("UPDATE context_registry_entries SET expires_at='2000-01-01T00:00:00.000Z' WHERE source_type='candidate_contact_cache'");
  await sendCandidatePrivateContact(db, principal, 'PL1234567890', deps);
  assert.equal(calls, 2);
  assert.equal((await sendCandidatePrivateContact(db, { ...principal, consultantId: 'mia' },
    'PL1234567890', deps)).data.delivery_status, 'fetch_failed');
});

test('多份简历有界尝试、图片空白与不完整不能误报成功', async () => {
  assert.deepEqual(extractResumeContact('电话 13812345678；email A@EXAMPLE.COM'),
    { phone: '13812345678', email: 'A@EXAMPLE.COM' });
  let downloads = 0;
  const three = Array.from({ length: 3 }, (_, i) => ({ attachmentId: `a${i}`,
    name: `简历${i}.pdf`, url: `https://res.ttcadvisory.com/${i}.pdf` }));
  const result = await readTtcResumeContact('PL1234567890', 'jwt', {
    listResumeFn: async () => three, downloadResumeFn: async () => { downloads += 1; return Buffer.from('pdf'); },
    pdfTextFn: () => downloads === 2 ? '邮箱：test@example.com' : '',
  });
  assert.equal(result.status, 'found'); assert.equal(downloads, 2);
  const image = await readTtcResumeContact('PL1234567890', 'jwt', {
    listResumeFn: async () => three, downloadResumeFn: async () => Buffer.from('pdf'),
    pdfTextFn: () => '',
  });
  assert.equal(image.status, 'no_contact');
  const incomplete = await readTtcResumeContact('PL1234567890', 'jwt', {
    listResumeFn: async () => [...three, { ...three[0], attachmentId: 'a3' }],
    downloadResumeFn: async () => Buffer.from('pdf'), pdfTextFn: () => '',
  });
  assert.equal(incomplete.status, 'fetch_failed');
  assert.equal((await readTtcResumeContact('PL1234567890', 'jwt', {
    listResumeFn: async () => [],
  })).status, 'no_resume');
});

test('TTC 鉴权失败与普通拉取错误分别回执，不能泄露原始异常', async t => {
  const { db } = fixture(t); binding(db);
  const deps = { appKeyHash: keyHash, getTtcJwtFn: () => 'own-jwt',
    loadCandidateContactFn: async () => { throw Object.assign(new Error(), { code: 'NOT_FOUND_OR_FORBIDDEN' }); },
    sendTextMessageFn: async () => assert.fail('失败不可私发') };
  const expired = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, readResumeFn: async () => { throw Object.assign(new Error('secret-token'), { authInvalid: true }); },
  });
  assert.equal(expired.data.delivery_status, 'credential_expired');
  const failed = await sendCandidatePrivateContact(db, principal, 'PL1234567890', {
    ...deps, readResumeFn: async () => { throw new Error('secret-token'); },
  });
  assert.equal(failed.data.delivery_status, 'fetch_failed');
  assert.doesNotMatch(JSON.stringify([expired, failed]), /secret-token/);
});

// PR#78 审查追认项：pdftotext 必须走异步子进程，事件循环不得被同步阻塞。缺 pdftotext 的环境跳过。
const pdftotextMissing = (() => { try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); return false; } catch (error) { return error.code === 'ENOENT'; } })();
test('pdfTextInMemory 异步解析内联 PDF 提取号码', { skip: pdftotextMissing }, async () => {
  const content = 'BT /F1 12 Tf 10 50 Td (13812345678) Tj ET';
  const pdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${content.length} >> stream
${content}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
trailer << /Root 1 0 R /Size 6 >>`;
  const text = await pdfTextInMemory(Buffer.from(pdf, 'latin1'));
  assert.match(text, /13812345678/);
  assert.deepEqual(extractResumeContact(text).phone, '13812345678');
  await assert.rejects(() => pdfTextInMemory(Buffer.from('not-a-pdf'), { timeoutMs: 10_000 }), /PDFTOTEXT_/);
});
