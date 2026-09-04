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

test('账号隔离：共享环境变量 token 不再作为全员回退（2026-09-04 加固）', () => {
  const db = openDb(':memory:');
  const orig = process.env.BRAINX_SUPERMAI_TOKEN;
  process.env.BRAINX_SUPERMAI_TOKEN = 'shared-account-token';
  try {
    // 未绑定本人 JWT → 必须不可用，绝不能借共享 token 搜（那就是拿别人的账号）
    assert.equal(getSupermaiCredentials(db, 'felix'), null);
    // 绑定了本人 JWT → 只用本人的
    saveTtcToken(db, 'felix', JWT, {
      userName: 'Felix', personId: 'person-felix', expiresAt: '2099-01-01T00:00:00.000Z',
    });
    assert.equal(getSupermaiCredentials(db, 'felix')?.token, JWT);
  } finally {
    if (orig === undefined) delete process.env.BRAINX_SUPERMAI_TOKEN;
    else process.env.BRAINX_SUPERMAI_TOKEN = orig;
  }
});
