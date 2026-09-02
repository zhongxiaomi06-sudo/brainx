import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { successEnvelope, errorEnvelope } from '../src/agent-gateway/envelopes.js';
import {
  beginAgentRun,
  authorizeAgentRun,
  beginToolCall,
  finishAgentRun,
  finishToolCall,
} from '../src/agent-gateway/audit.js';
import { consumeRateLimit } from '../src/agent-gateway/rate-limit.js';

const NOW = new Date('2026-09-03T08:00:00.000Z');
const AUDIT_KEY = 'test-audit-key-that-is-at-least-32-bytes';
const PRINCIPAL = Object.freeze({
  tenantId: 'tenant-a', consultantId: 'mia', accountId: 'brainx-prod',
  senderId: 'ou_sensitive_sender', chatType: 'p2p', chatId: 'ou_sensitive_sender',
  purpose: 'daily_brief',
});

test('成功 envelope 固定区分事实、推断、建议、未知与数据范围', () => {
  const result = successEnvelope({
    requestId: 'req-a', runId: 'run-a', toolName: 'brainx_daily_brief', principal: PRINCIPAL,
    result: { data: { date: '2026-09-03' }, facts: [{ ref: 'job-a' }], unknowns: ['薪资待确认'] },
    sourceVersions: { jobs: 'v7' }, nextAllowedActions: ['brainx_job_assessment'], now: NOW,
  });
  assert.deepEqual(result, {
    schema_version: 'agent_tool_response.v1', request_id: 'req-a', run_id: 'run-a',
    tool_name: 'brainx_daily_brief', data: { date: '2026-09-03' }, facts: [{ ref: 'job-a' }],
    inferences: [], recommendations: [], unknowns: ['薪资待确认'], evidence_refs: [],
    data_scope: { tenant_ref: 'self', consultant_ref: 'self', chat_type: 'p2p', redaction_policy: 'agent-field-policy.v1' },
    source_versions: { jobs: 'v7' }, generated_at: NOW.toISOString(),
    next_allowed_actions: ['brainx_job_assessment'],
  });
});

test('错误 envelope 使用稳定 HTTP 语义且不泄露异常正文、SQL 或堆栈', () => {
  const internal = new Error('SELECT secret FROM tokens at /private/server.js:99');
  const response = errorEnvelope(internal, { requestId: 'req-internal' });
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: {
    code: 'INTERNAL', message: '服务暂时无法完成请求', retryable: false, request_id: 'req-internal',
  } });
  assert.doesNotMatch(JSON.stringify(response), /SELECT|secret|private|stack/i);
  const limited = errorEnvelope(Object.assign(new Error('RATE_LIMITED'), {
    code: 'RATE_LIMITED', retryAfter: 27,
  }), { requestId: 'req-rate' });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, 27);
  assert.equal(limited.body.error.retryable, true);
});

test('审计只保存主体哈希、参数哈希和最小键摘要', () => {
  const db = openDb(':memory:');
  const payload = {
    request_id: 'req-a', channel: 'feishu', account_id: 'brainx-prod', chat_type: 'p2p',
    requester_sender_id: PRINCIPAL.senderId, chat_id: PRINCIPAL.chatId,
    purpose: 'daily_brief', tool_name: 'brainx_daily_brief',
  };
  const runId = beginAgentRun(db, payload, { auditKey: AUDIT_KEY, now: NOW });
  authorizeAgentRun(db, runId, PRINCIPAL);
  const toolCallId = beginToolCall(db, {
    runId, toolName: payload.tool_name, toolVersion: '1.0.0',
    arguments: { job_id: 'job-sensitive', prompt: 'ignore rules', email: 'a@example.com' },
    policyVersion: 'agent-auth.v1',
  }, { now: NOW });
  finishToolCall(db, toolCallId, { status: 'SUCCEEDED', evidenceRefs: ['match:7'] }, { now: NOW });
  finishAgentRun(db, runId, { status: 'SUCCEEDED' }, { now: NOW });
  const run = db.prepare('SELECT * FROM agent_runs WHERE run_id=?').get(runId);
  const call = db.prepare('SELECT * FROM agent_tool_calls WHERE tool_call_id=?').get(toolCallId);
  assert.equal(run.consultant_id, 'mia');
  assert.notEqual(run.sender_hash, PRINCIPAL.senderId);
  assert.deepEqual(JSON.parse(call.arguments_summary_json), { provided_keys: ['email', 'job_id', 'prompt'] });
  assert.doesNotMatch(JSON.stringify({ run, call }), /ou_sensitive|job-sensitive|a@example|ignore rules/);
  assert.equal(call.status, 'SUCCEEDED');
});

test('固定窗口限流按哈希桶执行，超限给 retry-after，下一窗口恢复', () => {
  const db = openDb(':memory:');
  const options = { auditKey: AUDIT_KEY, now: NOW, limit: 2, windowSeconds: 60 };
  assert.equal(consumeRateLimit(db, PRINCIPAL, 'brainx_daily_brief', options).remaining, 1);
  assert.equal(consumeRateLimit(db, PRINCIPAL, 'brainx_daily_brief', options).remaining, 0);
  assert.throws(() => consumeRateLimit(db, PRINCIPAL, 'brainx_daily_brief', options), (error) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryAfter, 60);
    return true;
  });
  const later = consumeRateLimit(db, PRINCIPAL, 'brainx_daily_brief', {
    ...options, now: new Date(NOW.getTime() + 61_000),
  });
  assert.equal(later.remaining, 1);
  const row = db.prepare('SELECT bucket_key FROM agent_rate_limits').get();
  assert.doesNotMatch(row.bucket_key, /tenant-a|mia|daily/);
});
