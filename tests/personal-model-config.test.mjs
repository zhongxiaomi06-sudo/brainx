import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';

test('migration creates a credential-free personal model projection', () => {
  const db = openDb(':memory:');
  const columns = db.prepare('PRAGMA table_info(consultant_model_profiles)').all();
  const names = columns.map(({ name }) => name);
  assert.deepEqual(names, [
    'consultant_id', 'feishu_account_id', 'agent_id', 'provider_id', 'model_id',
    'profile_id', 'status', 'consent_version', 'consented_at', 'configured_at',
    'disabled_at', 'last_error_code', 'updated_at',
  ]);
  assert.equal(names.some((name) => /key|secret|token|credential/i.test(name)), false);
  db.close();
});

test('migration rejects unsupported providers and duplicate agent ownership', () => {
  const db = openDb(':memory:');
  const insert = db.prepare(`INSERT INTO consultant_model_profiles
    (consultant_id,feishu_account_id,agent_id,provider_id,model_id,profile_id,status,
     consent_version,consented_at,configured_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const args = ['mia', 'mia', 'feishu-mia', 'openai', 'gpt-5.4', 'openai:brainx-a',
    'ACTIVE', 'model-data-consent.v1', '2026-09-03T00:00:00.000Z',
    '2026-09-03T00:00:01.000Z', '2026-09-03T00:00:01.000Z'];
  insert.run(...args);
  assert.throws(() => insert.run('felix', ...args.slice(1)), /UNIQUE/);
  assert.throws(() => insert.run('felix', 'mia', 'feishu-felix', 'unknown', ...args.slice(4)), /CHECK/);
  db.close();
});
