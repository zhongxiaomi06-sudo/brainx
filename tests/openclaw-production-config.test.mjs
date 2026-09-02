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
  assert.equal(feishu.connectionMode, 'websocket');
  assert.equal(feishu.dmPolicy, 'allowlist');
  assert.equal(feishu.groupPolicy, 'allowlist');
  assert.equal(feishu.requireMention, true);
  assert.deepEqual(feishu.allowFrom, ['${BRAINX_FEISHU_ALLOWED_OPEN_ID}']);
  assert.deepEqual(feishu.groupAllowFrom, ['${BRAINX_FEISHU_ALLOWED_OPEN_ID}']);
  assert.equal(feishu.groups['${BRAINX_FEISHU_ALLOWED_CHAT_ID}'].requireMention, true);
  assert.deepEqual(feishu.groups['${BRAINX_FEISHU_ALLOWED_CHAT_ID}'].allowFrom, ['${BRAINX_FEISHU_ALLOWED_OPEN_ID}']);
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
  assert.doesNotMatch(installer, /install -m 0600 -o root -g brainx/);
});
