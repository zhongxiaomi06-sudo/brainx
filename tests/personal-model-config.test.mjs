import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import {
  MODEL_CONSENT_VERSION,
  PERSONAL_MODEL_PROVIDERS,
  createOpenClawRunner,
  createPersonalModelService,
  validateModelInput,
} from '../src/personal-model-config.js';

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

const NOW = '2026-09-03T12:00:00.000Z';

function seedBinding(db, consultantId, openId) {
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES (?,?,?,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',?,?,
      'ACTIVE',?,'test',?,?)`).run(`b-${consultantId}`, 'tenant-a', 'mia', openId,
    consultantId, NOW, NOW, NOW);
}

function fakeCli() {
  const calls = [];
  const bindings = [
    { agentId: 'agent-mia', match: { channel: 'feishu', accountId: 'mia', peer: { kind: 'direct', id: 'ou_mia' } } },
    { agentId: 'agent-felix', match: { channel: 'feishu', accountId: 'mia', peer: { kind: 'direct', id: 'ou_felix' } } },
  ];
  const agents = [{ id: 'main' }, { id: 'agent-mia' }, { id: 'agent-felix' }];
  return {
    calls,
    async call(args, options = {}) {
      calls.push({ args: [...args], stdin: options.stdin });
      if (args.join(' ') === 'config get bindings --json') return { stdout: JSON.stringify(bindings) };
      if (args.join(' ') === 'config get agents.list --json') return { stdout: JSON.stringify(agents) };
      return { stdout: '' };
    },
  };
}

test('provider catalog and input validation reject identity fields, arbitrary endpoints and unsafe keys', () => {
  assert.deepEqual(PERSONAL_MODEL_PROVIDERS.map(({ id }) => id), ['openai', 'anthropic', 'google', 'stepfun']);
  const valid = validateModelInput({ provider_id: 'openai', model_id: 'gpt-5.4',
    api_key: 'sk-test-value', consent: true, consent_version: MODEL_CONSENT_VERSION });
  assert.equal(valid.modelId, 'gpt-5.4');
  for (const bad of [
    { provider_id: 'custom', model_id: 'x', api_key: '12345678', consent: true, consent_version: MODEL_CONSENT_VERSION },
    { provider_id: 'openai', model_id: '../bad', api_key: '12345678', consent: true, consent_version: MODEL_CONSENT_VERSION },
    { provider_id: 'openai', model_id: 'gpt', api_key: 'bad\nkey', consent: true, consent_version: MODEL_CONSENT_VERSION },
    { provider_id: 'openai', model_id: 'gpt', api_key: '12345678', consent: true,
      consent_version: MODEL_CONSENT_VERSION, base_url: 'https://evil.example' },
  ]) assert.throws(() => validateModelInput(bad), /MODEL_/);
});

test('OpenClaw runner uses fixed argv, stdin for keys, no shell, timeout and bounded output', async () => {
  let observed;
  const runner = createOpenClawRunner({
    bin: '/fixed/openclaw', timeoutMs: 50, maxOutputBytes: 1024,
    spawnImpl(command, args, options) {
      observed = { command, args, options };
      const listeners = {};
      const stream = () => ({ on(type, fn) { listeners[type] = fn; }, write(value) { observed.stdin = value; }, end() {} });
      const child = { stdout: stream(), stderr: stream(), stdin: stream(), on(type, fn) { listeners[`child:${type}`] = fn; }, kill() {} };
      queueMicrotask(() => listeners['child:close'](0));
      return child;
    },
  });
  await runner.call(['models', 'auth', '--agent', 'agent-mia', 'paste-api-key'], { stdin: 'top-secret\n' });
  assert.equal(observed.command, '/fixed/openclaw');
  assert.equal(observed.options.shell, false);
  assert.equal(observed.args.includes('top-secret'), false);
  assert.equal(observed.stdin, 'top-secret\n');

  const stalled = createOpenClawRunner({
    timeoutMs: 5,
    spawnImpl() {
      const stream = () => ({ on() {}, write() {}, end() {} });
      return { stdout: stream(), stderr: stream(), stdin: stream(), on() {}, kill() {} };
    },
  });
  await assert.rejects(() => stalled.call(['config', 'get', 'bindings']), /OPENCLAW_TIMEOUT/);
});

test('two consultants configure only their bound personal agents and keys never enter argv or DB', async () => {
  const db = openDb(':memory:');
  seedBinding(db, 'mia', 'ou_mia');
  seedBinding(db, 'felix', 'ou_felix');
  const cli = fakeCli();
  const service = createPersonalModelService({ db, cli, enabled: true, now: () => NOW });
  await service.configure({ consultantId: 'mia', openId: 'ou_mia' }, {
    provider_id: 'openai', model_id: 'gpt-5.4', api_key: 'mia-private-key',
    consent: true, consent_version: MODEL_CONSENT_VERSION,
  });
  await service.configure({ consultantId: 'felix', openId: 'ou_felix' }, {
    provider_id: 'anthropic', model_id: 'claude-sonnet-4-6', api_key: 'felix-private-key',
    consent: true, consent_version: MODEL_CONSENT_VERSION,
  });
  const writes = cli.calls.filter(({ args }) => args.includes('paste-api-key'));
  assert.deepEqual(writes.map(({ args }) => args[args.indexOf('--agent') + 1]), ['agent-mia', 'agent-felix']);
  assert.deepEqual(writes.map(({ stdin }) => stdin), ['mia-private-key\n', 'felix-private-key\n']);
  assert.equal(JSON.stringify(cli.calls.map(({ args }) => args)).includes('private-key'), false);
  const rows = db.prepare('SELECT consultant_id,agent_id,provider_id,model_id,status FROM consultant_model_profiles ORDER BY consultant_id').all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    { consultant_id: 'felix', agent_id: 'agent-felix', provider_id: 'anthropic', model_id: 'claude-sonnet-4-6', status: 'ACTIVE' },
    { consultant_id: 'mia', agent_id: 'agent-mia', provider_id: 'openai', model_id: 'gpt-5.4', status: 'ACTIVE' },
  ]);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM consultant_model_profiles').all()).includes('private-key'), false);
  db.close();
});

test('binding mismatch, concurrent mutation and CLI failure fail closed without exposing the key', async () => {
  const db = openDb(':memory:');
  seedBinding(db, 'mia', 'ou_mia');
  const cli = fakeCli();
  const service = createPersonalModelService({ db, cli, enabled: true, now: () => NOW });
  const notReady = await service.getStatus({ consultantId: 'mia', openId: 'ou_other' });
  assert.equal(notReady.agent_ready, false);
  let release;
  cli.call = async (args, options) => {
    if (args.join(' ') === 'config get bindings --json') return { stdout: JSON.stringify([
      { agentId: 'agent-mia', match: { channel: 'feishu', accountId: 'mia', peer: { kind: 'direct', id: 'ou_mia' } } },
    ]) };
    if (args.join(' ') === 'config get agents.list --json') return { stdout: JSON.stringify([{ id: 'agent-mia' }]) };
    if (args.includes('paste-api-key')) await new Promise((resolve) => { release = resolve; });
    return { stdout: '' };
  };
  const input = { provider_id: 'openai', model_id: 'gpt-5.4', api_key: 'never-log-me',
    consent: true, consent_version: MODEL_CONSENT_VERSION };
  const first = service.configure({ consultantId: 'mia', openId: 'ou_mia' }, input);
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => service.configure({ consultantId: 'mia', openId: 'ou_mia' }, input), /MODEL_CONFIG_BUSY/);
  release();
  await first;
  db.close();
});
