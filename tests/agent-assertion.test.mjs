import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.js';
import {
  canonicalJson,
  consumePrincipalNonce,
  createPrincipalAssertion,
  hashArguments,
  verifyPrincipalAssertion,
} from '../src/agent-gateway/assertion.js';

const SECRET = 'test-only-secret-that-is-at-least-32-bytes';
const NOW = new Date('2026-09-03T08:00:00.000Z');

function issue(overrides = {}, options = {}) {
  const requestId = overrides.request_id || randomUUID();
  const argumentsValue = options.arguments || { date: '2026-09-03', limit: 3 };
  return createPrincipalAssertion({
    request_id: requestId,
    channel: 'feishu',
    account_id: 'brainx-prod',
    requester_sender_id: 'ou_sender',
    chat_type: 'p2p',
    chat_id: 'ou_sender',
    thread_id: null,
    purpose: 'daily_brief',
    tool_name: 'brainx_daily_brief',
    arguments: argumentsValue,
    ...overrides,
  }, { secret: SECRET, now: NOW, ...options });
}

test('canonical JSON 与参数哈希不受对象键顺序影响', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(hashArguments({ b: 2, a: 1 }), hashArguments({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ value: undefined }), /ASSERTION_INVALID/);
});

test('合法短时主体声明可验签且绑定 request、tool 与 arguments', () => {
  const created = issue();
  const verified = verifyPrincipalAssertion(created.assertion, {
    secret: SECRET,
    requestId: created.payload.request_id,
    toolName: 'brainx_daily_brief',
    arguments: { limit: 3, date: '2026-09-03' },
    now: new Date(NOW.getTime() + 30_000),
  });
  assert.deepEqual(verified, created.payload);
});

test('签名、参数、工具或 request 任一篡改均失败关闭', () => {
  const created = issue();
  const common = { secret: SECRET, now: new Date(NOW.getTime() + 10_000) };
  assert.throws(() => verifyPrincipalAssertion(`${created.assertion}x`, {
    ...common, requestId: created.payload.request_id, toolName: created.payload.tool_name,
    arguments: { date: '2026-09-03', limit: 3 },
  }), /UNAUTHENTICATED/);
  assert.throws(() => verifyPrincipalAssertion(created.assertion, {
    ...common, requestId: created.payload.request_id, toolName: created.payload.tool_name,
    arguments: { date: '2026-09-03', limit: 4 },
  }), /ASSERTION_MISMATCH/);
  assert.throws(() => verifyPrincipalAssertion(created.assertion, {
    ...common, requestId: created.payload.request_id, toolName: 'brainx_me_context', arguments: {},
  }), /ASSERTION_MISMATCH/);
  assert.throws(() => verifyPrincipalAssertion(created.assertion, {
    ...common, requestId: randomUUID(), toolName: created.payload.tool_name,
    arguments: { date: '2026-09-03', limit: 3 },
  }), /ASSERTION_MISMATCH/);
});

test('过期、未来签发或超过 120 秒的声明被拒绝', () => {
  const expired = issue();
  assert.throws(() => verifyPrincipalAssertion(expired.assertion, {
    secret: SECRET, requestId: expired.payload.request_id, toolName: expired.payload.tool_name,
    arguments: { date: '2026-09-03', limit: 3 }, now: new Date(NOW.getTime() + 61_000),
  }), /ASSERTION_EXPIRED/);
  assert.throws(() => issue({}, { ttlSeconds: 121 }), /ASSERTION_INVALID/);
  const future = issue({}, { now: new Date(NOW.getTime() + 60_000) });
  assert.throws(() => verifyPrincipalAssertion(future.assertion, {
    secret: SECRET, requestId: future.payload.request_id, toolName: future.payload.tool_name,
    arguments: { date: '2026-09-03', limit: 3 }, now: NOW,
  }), /ASSERTION_NOT_YET_VALID/);
});

test('nonce 与 request_id 只能原子消费一次', () => {
  const db = openDb(':memory:');
  const { payload } = issue();
  assert.equal(consumePrincipalNonce(db, payload, { now: NOW }), true);
  assert.throws(() => consumePrincipalNonce(db, payload, { now: NOW }), /REPLAYED_REQUEST/);
});
