import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBrainxDeepLink, productionBaseUrl } from '../src/brainx-deep-links.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import { parseWorkbenchDeepLink } from '../frontend/btex-frontend/app/workbench-deep-link.ts';

test('object deep links use the controlled HTTPS workbench origin', () => {
  const href = buildBrainxDeepLink({
    baseUrl: 'https://base.yorkteam.cn/ignored?bad=1',
    objectType: 'opportunity', objectRef: 'job/一号', candidateRef: 'candidate:opaque',
  });
  const url = new URL(href);
  assert.equal(url.origin, 'https://base.yorkteam.cn');
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('open'), 'opportunity:job/一号');
  assert.equal(url.searchParams.get('candidate'), 'candidate:opaque');
  assert.deepEqual(parseWorkbenchDeepLink(url.search), {
    kind: 'opportunity', objectRef: 'job/一号', candidateRef: 'candidate:opaque',
  });
});

test('production base and parser fail closed on unsafe input', () => {
  const credentialed = new URL('https://example.com');
  credentialed.username = 'test-user';
  credentialed.password = 'test-password';
  for (const baseUrl of ['http://base.yorkteam.cn', 'http://127.0.0.1:3000', 'javascript:alert(1)', credentialed.href]) {
    assert.throws(() => productionBaseUrl(baseUrl), /BRAINX_BASE_URL_INVALID/);
  }
  const savedBase = process.env.BRAINX_BASE_URL;
  delete process.env.BRAINX_BASE_URL;
  assert.throws(() => productionBaseUrl(), /BRAINX_BASE_URL_REQUIRED/);
  if (savedBase !== undefined) process.env.BRAINX_BASE_URL = savedBase;
  assert.equal(parseWorkbenchDeepLink('?open=unknown:x'), null);
  assert.equal(parseWorkbenchDeepLink('?open=opportunity:'), null);
});

test('deep links carry references only and never grant browser authorization', () => {
  const url = new URL(buildBrainxDeepLink({
    baseUrl: 'https://base.yorkteam.cn', objectType: 'replay', objectRef: 'decision-1',
  }));
  assert.equal(url.searchParams.get('open'), 'replay:decision-1');
  for (const forbidden of ['consultant_id', 'tenant_id', 'open_id', 'token', 'scope']) {
    assert.equal(url.searchParams.has(forbidden), false);
  }
});

test('opening a deep-linked object still requires a web session and object visibility', async () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const job = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get();
  const server = createServer(db);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}/api/v1/opportunities/${encodeURIComponent(job.project_id)}`;
  try {
    assert.equal((await fetch(api)).status, 401);
    const miaCookie = `brainx_session=${encodeURIComponent(signSession('mia', 'ou_mia'))}`;
    assert.equal((await fetch(api, { headers: { Cookie: miaCookie } })).status, 404);
    const felixCookie = `brainx_session=${encodeURIComponent(signSession('felix', 'ou_felix'))}`;
    assert.equal((await fetch(api, { headers: { Cookie: felixCookie } })).status, 200);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
