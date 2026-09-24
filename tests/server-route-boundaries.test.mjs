import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authRoutes } from '../src/auth-routes.js';
import { connectionRoutes } from '../src/connection-routes.js';
import { supermaiRelayRoutes } from '../src/supermai-relay-routes.js';
import { talentRoutes } from '../src/talent-routes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const AUTH_KEYS = [
  'DELETE /api/v1/session',
  'GET /api/v1/oauth/authorize',
  'GET /api/v1/oauth/callback',
  'GET /api/v1/oauth/status',
  'GET /login',
  'POST /api/v1/session',
];

const TALENT_KEYS = [
  'GET /api/v1/opportunities/:id/talent-supply',
  'GET /api/v1/talent',
  'GET /api/v1/talent/:id',
  'GET /api/v1/talent/:id/resumes',
  'GET /api/v1/talent/health',
  'GET /api/v1/talent/status',
  'POST /api/v1/talent/resume',
  'POST /api/v1/talent/resumes',
  'POST /api/v1/talent/sync',
];

const CONNECTION_KEYS = [
  'GET /api/v1/auth/providers',
  'GET /api/v1/connections',
  'POST /api/v1/connections/supermai/start',
];

const SUPERMAI_RELAY_KEYS = [
  'DELETE /api/v1/connections/supermai/devices/:id',
  'GET /api/v1/supermai/connector/install',
  'GET /api/v1/supermai/connector/source',
  'POST /api/v1/connections/supermai/pairing-code',
  'POST /api/v1/sourcing/tasks/:id/finish',
  'POST /api/v1/sourcing/tasks/:id/ingest',
  'POST /api/v1/supermai/pair/claim',
  'POST /api/v1/supermai/relay/poll',
  'POST /api/v1/supermai/relay/report',
];

test('登录与人才 route factory 完整拥有原路由清单', () => {
  assert.deepEqual(Object.keys(authRoutes({}, { devAuth: false })).sort(), AUTH_KEYS);
  assert.deepEqual(Object.keys(connectionRoutes({})).sort(), CONNECTION_KEYS);
  assert.deepEqual(Object.keys(supermaiRelayRoutes({})).sort(), SUPERMAI_RELAY_KEYS);
  assert.deepEqual(Object.keys(talentRoutes({}, { rootDir: ROOT })).sort(), TALENT_KEYS);
});

test('server 入口回到 500 行内，只组装领域路由而不内嵌 handler', () => {
  const source = readFileSync(join(ROOT, 'src', 'server.js'), 'utf8');
  assert.ok(source.split(/\r?\n/).length - 1 <= 500, 'src/server.js 必须不超过 500 行');
  assert.match(source, /\.\.\.authRoutes\(db,/);
  assert.match(source, /\.\.\.connectionRoutes\(db,/);
  assert.match(source, /\.\.\.supermaiRelayRoutes\(db,/);
  assert.match(source, /\.\.\.talentRoutes\(db,/);
  assert.doesNotMatch(source, /['"]GET \/login['"]\s*:/);
  assert.doesNotMatch(source, /['"]GET \/api\/v1\/talent\/status['"]\s*:/);
  assert.doesNotMatch(source, /from ['"]\.\/oauth\.js['"]/);
  assert.doesNotMatch(source, /from ['"]\.\/talent(?:-supply)?\.js['"]/);
});

test('质量门禁不再豁免 server.js 超限', () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, '.quality-gate', 'baseline.json'), 'utf8'));
  assert.equal(baseline.oversizedFiles.some((item) => item.path === 'src/server.js'), false);
});
