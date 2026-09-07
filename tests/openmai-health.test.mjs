import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import { healthCheck } from '../bin/brainx-openmai-health.mjs';

test('OpenMai 晨检选择任一有效顾问凭证且只做无副作用 GET', async () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'wendy', 'header.payload.signature', {
    userName: 'Wendy', personId: 'p-wendy', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const calls = [];
  const out = await healthCheck(db, {
    quotaFn: async (jwt) => { assert.equal(jwt, 'header.payload.signature'); return { remaining: 10 }; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response('method not allowed', { status: 405 });
    },
  });
  assert.equal(out.openmai, 'reachable(405)');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer header.payload.signature');
  assert.ok(out.consultants.find((row) => row.consultant_id === 'wendy')?.quota === 'ok');
  db.close();
});

test('OpenMai 晨检没有任何有效凭证时不发网络请求', async () => {
  const db = openDb(':memory:');
  let called = false;
  const out = await healthCheck(db, {
    quotaFn: async () => ({}), fetchImpl: async () => { called = true; },
  });
  assert.equal(out.openmai, 'no_jwt');
  assert.equal(called, false);
  assert.equal(out.ok, false);
  db.close();
});
