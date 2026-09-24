import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import { connectionStatuses } from '../src/connection-providers.js';
import { launchSupermaiPlatform, supermaiLocalStatus } from '../src/supermai-local-connector.js';

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

test('SuperMai 启动动作只接受内建平台且不允许调用方传 URL', async () => {
  let request = null;
  const launched = await launchSupermaiPlatform('boss', { fetchImpl: async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true }));
  } });
  assert.deepEqual(launched, {
    ok: true, platform: 'boss', user_action: 'COMPLETE_OFFICIAL_LOGIN',
  });
  assert.deepEqual(request, {
    url: 'http://127.0.0.1:8910/api/v1/chrome/launch', body: { platform: 'boss' },
  });
  assert.equal((await launchSupermaiPlatform('https://evil.example')).error_code,
    'SUPERMAI_PLATFORM_INVALID');
});

test('provider 目录公开，连接状态必须登录且不泄露来源凭据', async () => {
  const db = openDb(':memory:');
  const launches = [];
  const server = createServer(db, { connections: {
    readSupermaiStatus: async () => ({ available: false, error_code: 'SUPERMAI_DESKTOP_UNAVAILABLE' }),
    readReloopHealth: async () => ({ ready: true, backend: 'mysql', schema: 'ready' }),
    launchSupermaiPlatform: async (platform) => {
      launches.push(platform);
      return { ok: true, platform, user_action: 'COMPLETE_OFFICIAL_LOGIN' };
    },
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
    const deniedLaunch = await fetch(`${base}/api/v1/connections/supermai/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'boss' }),
    });
    assert.equal(deniedLaunch.status, 401);

    const allowed = await fetch(`${base}/api/v1/connections`, { headers: cookie() });
    assert.equal(allowed.status, 200);
    const body = await allowed.json();
    assert.equal(body.items.length, 4);
    assert.doesNotMatch(JSON.stringify(body), /jwt|cookie|password|127\.0\.0\.1|8910/i);

    const launch = await fetch(`${base}/api/v1/connections/supermai/start`, {
      method: 'POST', headers: { ...cookie(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'maimai', url: 'https://evil.example' }),
    });
    assert.equal(launch.status, 200);
    assert.deepEqual(launches, ['maimai']);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});
