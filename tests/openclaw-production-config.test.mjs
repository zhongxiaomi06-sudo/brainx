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
  // 2026-09-12 起启用：插件 before_prompt_build 注入 BrainTex playbook，NL 流程纪律依赖它（灰测实证 false 时 playbook 从未生效）。
  assert.equal(config.plugins.entries['brainx-openclaw'].hooks.allowPromptInjection, true);
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
  assert.deepEqual(config.agents.defaults.model, {
    primary: 'stepfun/step-3.5-flash', fallbacks: ['stepfun/step-3.7-flash'],
  });
  assert.deepEqual(config.agents.defaults.models, {
    'stepfun/step-3.5-flash': { alias: 'fast' },
    'stepfun/step-3.7-flash': { alias: 'strong' },
  });
  assert.deepEqual(config.models.providers.stepfun.apiKey, {
    source: 'env', provider: 'default', id: 'STEPFUN_API_KEY',
  });
  assert.deepEqual(config.models.providers.stepfun.models.map(({ id }) => id), [
    'step-3.5-flash', 'step-3.7-flash',
  ]);
  const mia = config.channels.feishu.accounts.mia;
  // OpenClaw 外部化 feishu 插件（≥2026.5.2）无法解析 SecretRef，消息 dispatch 抛
  // FeishuSecretRefUnavailableError（issue #76451）。改用与 appId 一致的 ${VAR} 环境变量引用。
  assert.equal(mia.appSecret, '${BRAINX_FEISHU_APP_SECRET}');
  const serialized = JSON.stringify(config);
  assert.doesNotMatch(serialized, /cli_[a-f0-9]{12,}|sk-[A-Za-z0-9]|Bearer\s+/);
});

test('personal Feishu DMs get isolated dynamic agents and shared BrainX skills', () => {
  const feishu = config.channels.feishu;
  assert.equal(feishu.configWrites, true);
  assert.deepEqual(feishu.dynamicAgentCreation, {
    enabled: true,
    workspaceTemplate: '/var/lib/brainx/.openclaw/workspace-{agentId}',
    agentDirTemplate: '/var/lib/brainx/.openclaw/agents/{agentId}/agent',
    maxAgents: 20,
  });
  assert.equal(config.tools.sessions.visibility, 'self');
  assert.equal(config.tools.agentToAgent.enabled, false);
  assert.deepEqual(config.agents.defaults.skills, [
    'brainx-today', 'brainx-job', 'brainx-talent', 'brainx-match',
    'brainx-engagement-draft', 'brainx-interview-prep', 'brainx-review',
    'brainx-sourcing-reloop', 'brainx-sourcing-openmai', 'brainx-sourcing-supermai',
  ]);
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
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_7}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_8}',
    '${BRAINX_FEISHU_ALLOWED_OPEN_ID_9}',
  ];
  assert.equal(feishu.connectionMode, 'websocket');
  assert.equal(feishu.streaming, false, 'final reply hook needs to own the completed rich card');
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
  const names = ['brainx-agent-gateway', 'brainx-worker', 'brainx-integration-worker', 'openclaw-brainx'];
  for (const name of names) {
    const unit = await readFile(new URL(`deploy/systemd/${name}.service`, root), 'utf8');
    assert.match(unit, /^User=brainx$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
    assert.match(unit, /^EnvironmentFile=\/etc\/brainx\//m);
    assert.match(unit, /^ExecStartPre=\/usr\/bin\/node \/opt\/brainx\/bin\/brainx-runtime-preflight\.mjs$/m);
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
  assert.match(installer, /config patch --file/);
  assert.doesNotMatch(installer, /config unset.*agents\.defaults\.model/);
  assert.doesNotMatch(installer, /install[^\n]+openclaw\.production\.json[^\n]+openclaw\.json/);
  assert.match(installer, /plugins inspect feishu --json/);
  assert.match(installer, /plugin\?\.version===process\.argv\[1\]/);
  assert.match(installer, /\. \/etc\/brainx\/openclaw\.env; set \+a; exec "\$0" "\$@"/);
  assert.match(installer, /@openclaw\/feishu@2026\.7\.1/);
  assert.match(installer, /plugins\/brainx-openclaw\/package\.json/);
  assert.match(installer, /brainx-openclaw-plugin-\$\{BRAINX_PLUGIN_VERSION\}\.tgz/);
  assert.match(installer, /--check\|--apply\|--validate/);
  assert.match(installer, /brainx-runtime-preflight\.mjs/);
  assert.doesNotMatch(installer, /brainx-openclaw-plugin-1\.0\.0\.tgz/);
  assert.match(installer, /chown brainx:brainx "\$BRAINX_PLUGIN_TMP"/);
  assert.match(installer, /sudo -u brainx env HOME=\/var\/lib\/brainx\s+\\\s+npm pack/);
  assert.match(installer, /systemctl is-active --quiet openclaw-brainx/);
  assert.match(installer, /systemctl restart openclaw-brainx/);
  // H-3：安装器技能清单必须与生产配置完全一致（双向）。曾发生配置加了 3 个
  // sourcing 技能而安装器没跟上：全新机器 --apply 后三通道找人静默失效，且旧
  // 断言只硬编码 7 个技能、与安装器同构，永远绿拦不住。以配置为真值源断言。
  const installerSkills = installer.match(/^BRAINX_PRODUCTION_SKILLS=\($([\s\S]*?)^\)/m);
  assert.ok(installerSkills, 'install.sh 应声明 BRAINX_PRODUCTION_SKILLS 数组');
  const declared = new Set(installerSkills[1].split('\n').map((line) => line.trim()).filter(Boolean));
  assert.deepEqual(
    [...declared].sort(),
    [...config.agents.defaults.skills].sort(),
    'install.sh 的 BRAINX_PRODUCTION_SKILLS 必须与 openclaw.production.json 的 agents.defaults.skills 一致',
  );
  assert.match(installer, /\$BRAINX_OPENCLAW_STATE\/skills\/\$skill_name\/SKILL\.md/);
  assert.doesNotMatch(installer, /\$\{env_name\}\.env\.example/);
  assert.doesNotMatch(installer, /install -m 0600 -o root -g brainx/);
});

test('OpenClaw env template provides nine consultants and three groups', async () => {
  const template = await readFile(new URL('deploy/openclaw/openclaw.env.example', root), 'utf8');
  assert.match(template, /^BRAINX_BASE_URL=https:\/\//m);
  assert.match(template, /^STEPFUN_API_KEY=replace-stepfun-api-key$/m);
  assert.match(template, /^BRAINX_PERSONAL_MODELS_ENABLED=1$/m);
  for (const suffix of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
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
  assert.match(template, /^BRAINX_FEISHU_CREDENTIALS_FROM_OPENCLAW=1$/m);
  assert.match(template, /^BRAINX_OPENCLAW_CONFIG_PATH=\//m);
  assert.match(template, /^BRAINX_FEISHU_DOC_BASE_URL=https:\/\/.+\.feishu\.cn$/m);
  assert.doesNotMatch(template, /^BRAINX_AGENT_AUDIT_SECRET=/m);
  assert.doesNotMatch(template, /^BRAINX_DB_PATH=/m);
  assert.match(template, /^BRAINX_MYSQL_USER=brainx_agent_readonly$/m);
  assert.doesNotMatch(template, /^BRAINX_(RELOOP_SYNC|MATCH_EVAL|DOCUMENT_PARSER)_ENABLED=/m);
});

test('worker has a separate least-DML environment and systemd does not reuse Agent credentials', async () => {
  const template = await readFile(new URL('deploy/openclaw/brainx-worker.env.example', root), 'utf8');
  assert.match(template, /^BRAINX_DB=\/opt\/brainx\/data\/brainx\.sqlite$/m);
  assert.match(template, /^BRAINX_BASE_URL=https:\/\//m);
  assert.match(template, /^BRAINX_MYSQL_USER=brainx_worker_runtime$/m);
  assert.match(template, /^BRAINX_RELOOP_SYNC_ENABLED=1$/m);
  assert.match(template, /^BRAINX_DOCUMENT_LLM_ENABLED=0$/m);
  assert.match(template, /^BRAINX_TENANT_ID=/m);
  assert.match(template, /^BRAINX_RELOOP_SOURCE_OWNER_ID=/m);
  assert.doesNotMatch(template, /^BRAINX_AGENT_(GATEWAY_TOKEN|ASSERTION_SECRET|AUDIT_KEY)=/m);

  const businessWorker = await readFile(new URL('deploy/systemd/brainx-worker.service', root), 'utf8');
  assert.match(businessWorker, /^EnvironmentFile=\/etc\/brainx\/worker\.env$/m);
  assert.match(businessWorker, /^ExecStart=\/usr\/bin\/node \/opt\/brainx\/src\/worker\.js$/m);
  assert.match(businessWorker, /^Environment=BRAINX_EMBED_WORKER=0$/m);
  const integrationWorker = await readFile(new URL('deploy/systemd/brainx-integration-worker.service', root), 'utf8');
  assert.match(integrationWorker, /^EnvironmentFile=\/etc\/brainx\/worker\.env$/m);
  assert.match(integrationWorker, /bin\/brainx-integration-worker\.mjs/);
  for (const unit of [businessWorker, integrationWorker]) {
    assert.doesNotMatch(unit, /^EnvironmentFile=\/etc\/brainx\/agent\.env$/m);
  }
  const installer = await readFile(new URL('deploy/openclaw/install.sh', root), 'utf8');
  assert.match(installer, /deploy\/systemd\/brainx-worker\.service/);
});
