/** openmai-fallback.test.mjs — TTC 凭证隔离回归：
 * 顾问没有本人凭证时必须失败，不得借用其他顾问的凭证代执行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { startOpenmaiTask, getOpenmaiResult } from '../src/openmai-task.js';
import { saveTtcToken, validateJwt } from '../src/ttcsdk/auth.js';

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const fakeJwt = () => `${b64url({ alg: 'none' })}.${b64url({
  exp: Math.floor(Date.now() / 1000) + 3600,
  name: '测试',
})}.sig`;

test('startOpenmaiTask 不借用其他顾问的 TTC 凭证', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const jwt = fakeJwt();
  saveTtcToken(db, 'felix', jwt, validateJwt(jwt));

  let requested = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    requested = true;
    throw new Error('无本人凭证时不应发起网络请求');
  };

  try {
    const result = startOpenmaiTask(db, null, 'york', 'P-FIX-6FFEA4D1');
    assert.equal(result.status, 'error');
    assert.match(result.message, /没有个人或已授权的团队 TTC 寻访凭证/);
    assert.equal(requested, false);
    assert.equal(getOpenmaiResult(db, 'york', 'P-FIX-6FFEA4D1').status, 'failed');
  } finally {
    globalThis.fetch = realFetch;
  }
});
