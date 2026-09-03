import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { saveTtcToken } from '../src/ttcsdk/auth.js';
import { getSupermaiCredentials, saveSupermaiCredentials } from '../src/supermai-sourcing.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTk5OTk5OTl9.signature';

test('SuperMai 凭证在无独立凭证时复用顾问本人 TTC JWT（token=JWT）', () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const creds = getSupermaiCredentials(db, 'felix');
  assert.ok(creds, '应有凭证（回退到 JWT）');
  assert.equal(creds.token, JWT, 'Bearer token 应等于顾问本人 TTC JWT');
  assert.equal(creds.cloudBaseUrl, 'https://gateway.ttcadvisory.com', '默认复用 OpenMai 同一 TTC gateway');
});

test('SuperMai 独立凭证表优先于 TTC JWT 复用', () => {
  const db = openDb(':memory:');
  saveTtcToken(db, 'felix', JWT, {
    userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
  });
  saveSupermaiCredentials(db, 'felix', 'https://supermai.example.com', 'independent-token');
  const creds = getSupermaiCredentials(db, 'felix');
  assert.equal(creds.cloudBaseUrl, 'https://supermai.example.com');
  assert.equal(creds.token, 'independent-token');
});

test('无任何凭证时返回 null（fail-closed，不抛异常）', () => {
  const db = openDb(':memory:');
  assert.equal(getSupermaiCredentials(db, 'felix'), null);
});
