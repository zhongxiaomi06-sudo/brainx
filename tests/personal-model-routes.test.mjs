import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import { PersonalModelError } from '../src/personal-model-config.js';

async function withServer(service, fn, options = {}) {
  const db = openDb(':memory:');
  const server = createServer(db, {
    personalModelService: service,
    personalModelAdmins: options.admins || ['york'],
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    await fn(`http://127.0.0.1:${address.port}`, db);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
}

const cookie = (consultant, openId = `ou_${consultant}`) => ({
  Cookie: `brainx_session=${encodeURIComponent(signSession(consultant, openId))}`,
  'Content-Type': 'application/json',
});

test('model profile routes use session identity and never return the submitted key', async () => {
  const calls = [];
  const service = {
    async getStatus(identity) { calls.push(['get', identity]); return { ready: false, providers: [] }; },
    async configure(identity, input) {
      calls.push(['put', identity, input.api_key]);
      return { ready: true, provider_id: input.provider_id, model_id: input.model_id, status: 'ACTIVE' };
    },
    async disable(identity) { calls.push(['delete', identity]); return { status: 'DISABLED' }; },
  };
  await withServer(service, async (base) => {
    const get = await fetch(`${base}/api/v1/model-profile`, { headers: cookie('mia') });
    assert.equal(get.status, 200);
    const put = await fetch(`${base}/api/v1/model-profile`, {
      method: 'PUT', headers: cookie('mia'), body: JSON.stringify({
        provider_id: 'openai', model_id: 'gpt-5.4', api_key: 'private-value',
        consent: true, consent_version: 'model-data-consent.v1',
      }),
    });
    assert.equal(put.status, 200);
    assert.doesNotMatch(await put.text(), /private-value|api_key/);
    const del = await fetch(`${base}/api/v1/model-profile`, { method: 'DELETE', headers: cookie('mia') });
    assert.equal(del.status, 200);
  });
  assert.deepEqual(calls.map((item) => item[1]), [
    { consultantId: 'mia', openId: 'ou_mia' },
    { consultantId: 'mia', openId: 'ou_mia' },
    { consultantId: 'mia', openId: 'ou_mia' },
  ]);
});

test('model profile rejects missing open_id, oversized input and normalized service failures', async () => {
  const service = {
    async getStatus() { throw new PersonalModelError('PERSONAL_AGENT_NOT_READY'); },
    async configure() { throw new Error('provider said key=do-not-leak'); },
    async disable() { return {}; },
  };
  await withServer(service, async (base) => {
    const noOpenId = await fetch(`${base}/api/v1/model-profile`, { headers: cookie('mia', '') });
    assert.equal(noOpenId.status, 401);
    const missingAgent = await fetch(`${base}/api/v1/model-profile`, { headers: cookie('mia') });
    assert.equal(missingAgent.status, 409);
    const failed = await fetch(`${base}/api/v1/model-profile`, {
      method: 'PUT', headers: cookie('mia'), body: JSON.stringify({ value: 'safe' }),
    });
    assert.equal(failed.status, 502);
    assert.doesNotMatch(await failed.text(), /do-not-leak|provider said/);
    const large = await fetch(`${base}/api/v1/model-profile`, {
      method: 'PUT', headers: cookie('mia'), body: JSON.stringify({ api_key: 'x'.repeat(5000) }),
    });
    assert.equal(large.status, 413);
  });
});

test('admin readiness is non-sensitive and unavailable to ordinary consultants', async () => {
  const service = { async getStatus() {}, async configure() {}, async disable() {} };
  await withServer(service, async (base, db) => {
    db.prepare(`INSERT INTO consultant_model_profiles
      (consultant_id,feishu_account_id,agent_id,provider_id,model_id,profile_id,status,
       consent_version,consented_at,configured_at,updated_at)
      VALUES ('mia','mia','agent-mia','openai','gpt-5.4','openai:brainx-personal',
       'ACTIVE','model-data-consent.v1','2026-09-03','2026-09-03','2026-09-03')`).run();
    const denied = await fetch(`${base}/api/v1/admin/model-profiles`, { headers: cookie('mia') });
    assert.equal(denied.status, 403);
    const allowed = await fetch(`${base}/api/v1/admin/model-profiles`, { headers: cookie('york') });
    assert.equal(allowed.status, 200);
    const text = await allowed.text();
    assert.match(text, /agent-mia|gpt-5\.4/);
    assert.doesNotMatch(text, /api_key|secret|credential/);
  });
});
