import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import { connectionStatuses } from '../src/connection-providers.js';
import { supermaiLocalStatus } from '../src/supermai-local-connector.js';

const cookie = (consultant = 'mia') => ({
  Cookie: `brainx_session=${encodeURIComponent(signSession(consultant, `ou_${consultant}`))}`,
});

test('SuperMai 本地连接器只允许 loopback，且只输出窄状态', async () => {
  let called = false;
  const rejected = await supermaiLocalStatus({
    baseUrl: 'https://example.com/',
    fetchImpl: async () => { called = true; },
  });
  assert.equal(called, false);
  assert.equal(rejected.error_code, 'SUPERMAI_LOCAL_BASE_INVALID');

  const urls = [];
  const output = await supermaiLocalStatus({
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ ok: true, version: '0.3.6', busy: false, token: 'never-return' }));
      }
      return new Response(JSON.stringify({ platforms: {
        boss: { running: true, logged_in: true, cookie: 'never-return' },
        maimai: { running: false, logged_in: null },
      } }));
    },
  });
  assert.deepEqual(urls, [
    'http://127.0.0.1:8910/api/v1/health',
    'http://127.0.0.1:8910/api/v1/chrome/status',
  ]);
  assert.deepEqual(output, {
    available: true, version: '0.3.6', busy: false, error_code: null,
    platforms: {
      boss: { running: true, logged_in: true },
      maimai: { running: false, logged_in: null },
      liepin: { running: false, logged_in: null },
    },
  });
  assert.doesNotMatch(JSON.stringify(output), /never-return/);
});

test('统一连接状态区分用户登录、设备连接和组织连接', async () => {
  const db = openDb(':memory:');
  const output = await connectionStatuses(db, 'mia', {
    readSupermaiStatus: async () => ({
      available: true, version: '0.3.6', busy: false, error_code: null,
      platforms: { boss: { running: false, logged_in: null } },
    }),
    readReloopHealth: async () => ({ ready: true, backend: 'mysql', schema: 'ready' }),
  });
  assert.equal(output.identity_provider, 'feishu');
  assert.deepEqual(output.items.map((item) => item.provider),
    ['feishu', 'openmai', 'supermai', 'reloop']);
  assert.equal(output.items[0].state, 'action_required');
  assert.equal(output.items[1].error_code, 'OPENMAI_GRANT_REQUIRED');
  assert.equal(output.items[2].error_code, 'SUPERMAI_PLATFORM_LOGIN_REQUIRED');
  assert.equal(output.items[3].state, 'organization_managed');
  assert.equal(output.items[3].needs_user_action, false);
});

test('provider 目录公开，连接状态必须登录且不泄露来源凭据', async () => {
  const db = openDb(':memory:');
  const server = createServer(db, { connections: {
    readSupermaiStatus: async () => ({ available: false, error_code: 'SUPERMAI_DESKTOP_UNAVAILABLE' }),
    readReloopHealth: async () => ({ ready: true, backend: 'mysql', schema: 'ready' }),
  } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const providers = await fetch(`${base}/api/v1/auth/providers`);
    assert.equal(providers.status, 200);
    const catalog = await providers.json();
    assert.deepEqual(catalog.providers.map((item) => item.provider), ['feishu']);
    assert.equal(catalog.providers[0].flow, 'authorization_code_system_browser');

    const denied = await fetch(`${base}/api/v1/connections`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${base}/api/v1/connections`, { headers: cookie() });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.items.length, 4);
    assert.doesNotMatch(JSON.stringify(body), /jwt|cookie|password|127\.0\.0\.1|8910/i);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
