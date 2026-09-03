import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const readJson = async (path) => JSON.parse(await readFile(new URL(path, root)));
const config = await readJson('deploy/openclaw/openclaw.production.json');
const contract = await readJson('tests/fixtures/openclaw-production/plugin-contract.json');

test('production config loads only Feishu and BrainX plugins', () => {
  assert.deepEqual(config.plugins.allow, ['feishu', 'brainx-openclaw']);
  assert.equal(config.plugins.entries['brainx-openclaw'].enabled, true);
  assert.equal(config.plugins.entries['brainx-openclaw'].hooks.allowPromptInjection, false);
  assert.deepEqual(config.tools.allow, contract.allowed_tools);
  for (const denied of contract.denied_tool_ids) assert.ok(config.tools.deny.includes(denied), denied);
});

test('production config isolates sessions, sandboxes all runs, and exposes no plaintext secrets', () => {
  assert.equal(config.session.dmScope, 'per-account-channel-peer');
  assert.deepEqual(config.agents.defaults.sandbox, {
    mode: 'all', scope: 'session', workspaceAccess: 'none',
  });
  assert.equal(config.gateway.bind, 'loopback');
  assert.deepEqual(config.gateway.auth.token, {
    source: 'env', provider: 'default', id: 'OPENCLAW_GATEWAY_TOKEN',
  });
  const mia = config.channels.feishu.accounts.mia;
  assert.deepEqual(mia.appSecret, {
    source: 'env', provider: 'default', id: 'BRAINX_FEISHU_APP_SECRET',
  });
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /cli_[a-f0-9]{12,}|sk-[A-Za-z0-9]|Bearer\s+/);
});

test('Feishu is websocket-only, allowlisted, and mention-gated in groups', () => {
  const feishu = config.channels.feishu;
  const allowedPeople = [
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_1}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_2}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_3}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_4}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_5}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_6}',
  ];
  assert.equal(feishu.connectionMode, 'websocket');
  assert.equal(feishu.dmPolicy, 'allowlist');
  assert.equal(feishu.groupPolicy, 'allowlist');
  assert.equal(feishu.requireMention, true);
  assert.deepEqual(feishu.allowFrom, allowedPeople);
  assert.deepEqual(feishu.groupAllowFrom, [
    '${BRAINX_FEISHU_ALLOWED_CHAT_ID_1}',
    '${BRAINX_FEISHU_ALLOWED_CHAT_ID_2}',
    '${BRAINX_FEISHU_ALLOWED_CHAT_ID_3}',
  ]);
  assert.deepEqual(feishu.groupSenderAllowFrom, allowedPeople);
  assert.equal(feishu.groups, undefined);
});

test('systemd units keep internal services on one host and load secrets from protected files', async () => {
  const names = ['brainx-agent-gateway', 'brainx-integration-worker', 'openclaw-brainx'];
  for (const name of names) {
    const unit = await readFile(new URL(`deploy/systemd/${name}.service`, root), 'utf8');
    assert.match(unit, /^User=brainx$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^EnvironmentFile=\/etc\/brainx\//m);
    assert.doesNotMatch(unit, /(SECRET|TOKEN|PASSWORD)=\S+/);
  }
  const gateway = await readFile(new URL('deploy/systemd/brainx-agent-gateway.service', root), 'utf8');
  assert.match(gateway, /BRAINX_AGENT_GATEWAY_HOST=127\.0\.0\.1/);
  assert.match(gateway, /BRAINX_AGENT_GATEWAY_PORT=3102/);
  const installer = await readFile(new URL('deploy/openclaw/install.sh', root), 'utf8');
  assert.match(installer, /install -m 0640 -o root -g brainx/);
  assert.match(installer, /brainx-agent\.env\.example/);
  assert.match(installer, /brainx-worker\.env\.example/);
  assert.match(installer, /openclaw\.env\.example/);
  assert.match(installer, /OPENCLAW_CONFIG_PATH=/);
  assert.match(installer, /OPENCLAW_STATE_DIR=/);
  assert.match(installer, /@openclaw\/feishu@2026\.7\.1/);
  assert.doesNotMatch(installer, /\$\{env_name\}\.env\.example/);
  assert.doesNotMatch(installer, /install -m 0600 -o root -g brainx/);
});

test('OpenClaw env template provides six consultants and three groups', async () => {
  const template = await readFile(new URL('deploy/openclaw/openclaw.env.example', root), 'utf8');
  for (const suffix of ['1', '2', '3', '4', '5', '6']) {
    assert.match(template, new RegExp(`^BRAINX_FEISHU_ALLOWED_OPEN_ID_${suffix}=`, 'm'));
  }
  for (const suffix of ['1', '2', '3']) {
    assert.match(template, new RegExp(`^BRAINX_FEISHU_ALLOWED_CHAT_ID_${suffix}=`, 'm'));
  }
  assert.doesNotMatch(template, /^BRAINX_FEISHU_ALLOWED_(OPEN|CHAT)_ID=/m);
});

test('Agent env template uses the exact variable names consumed by runtime', async () => {
  const template = await readFile(new URL('deploy/openclaw/brainx-agent.env.example', root), 'utf8');
  assert.match(template, /^BRAINX_AGENT_AUDIT_KEY=/m);
  assert.match(template, /^BRAINX_DB=/m);
  assert.match(template, /^BRAINX_AGENT_FEISHU_APP_KEYS_JSON=/m);
  assert.match(template, /^BRAINX_AGENT_ADMIN_ID=/m);
  assert.match(template, /^BRAINX_AGENT_ADMIN_ALLOWLIST=/m);
  assert.doesNotMatch(template, /^BRAINX_AGENT_AUDIT_SECRET=/m);
  assert.doesNotMatch(template, /^BRAINX_DB_PATH=/m);
  assert.match(template, /^BRAINX_MYSQL_USER=brainx_agent_readonly$/m);
  assert.doesNotMatch(template, /^BRAINX_(RELOOP_SYNC|MATCH_EVAL|DOCUMENT_PARSER)_ENABLED=/m);
});

test('worker has a separate least-DML environment and systemd does not reuse Agent credentials', async () => {
  const template = await readFile(new URL('deploy/openclaw/brainx-worker.env.example', root), 'utf8');
  assert.match(template, /^BRAINX_DB=\/opt\/brainx\/data\/brainx\.sqlite$/m);
  assert.match(template, /^BRAINX_MYSQL_USER=brainx_worker_runtime$/m);
  assert.match(template, /^BRAINX_RELOOP_SYNC_ENABLED=1$/m);
  assert.match(template, /^BRAINX_DOCUMENT_LLM_ENABLED=0$/m);
  assert.match(template, /^BRAINX_TENANT_ID=/m);
  assert.match(template, /^BRAINX_RELOOP_SOURCE_OWNER_ID=/m);
  assert.doesNotMatch(template, /^BRAINX_AGENT_(GATEWAY_TOKEN|ASSERTION_SECRET|AUDIT_KEY)=/m);

  const worker = await readFile(new URL('deploy/systemd/brainx-integration-worker.service', root), 'utf8');
  assert.match(worker, /^EnvironmentFile=\/etc\/brainx\/worker\.env$/m);
  assert.doesNotMatch(worker, /^EnvironmentFile=\/etc\/brainx\/agent\.env$/m);
});
