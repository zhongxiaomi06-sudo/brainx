import { spawn } from 'node:child_process';

export const MODEL_CONSENT_VERSION = 'model-data-consent.v1';
export const PERSONAL_MODEL_PROVIDERS = Object.freeze([
  { id: 'openai', label: 'OpenAI', example_models: ['gpt-5.4'] },
  { id: 'anthropic', label: 'Anthropic', example_models: ['claude-sonnet-4-6'] },
  { id: 'google', label: 'Google Gemini', example_models: ['gemini-3-flash-preview'] },
  { id: 'stepfun', label: '阶跃 StepFun', example_models: ['step-3.5-flash', 'step-3.7-flash'] },
]);

const PROVIDER_IDS = new Set(PERSONAL_MODEL_PROVIDERS.map(({ id }) => id));
const FORBIDDEN_FIELDS = ['consultant_id', 'open_id', 'agent_id', 'base_url', 'command', 'args', 'env'];
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

export class PersonalModelError extends Error {
  constructor(code, options = {}) {
    super(code, options);
    this.name = 'PersonalModelError';
    this.code = code;
  }
}

function fail(code, cause) {
  throw new PersonalModelError(code, cause ? { cause } : {});
}

export function validateModelInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('MODEL_INPUT_INVALID');
  if (FORBIDDEN_FIELDS.some((field) => Object.hasOwn(input, field))) fail('MODEL_INPUT_INVALID');
  const providerId = String(input.provider_id || '').trim();
  const modelId = String(input.model_id || '').trim();
  const apiKey = typeof input.api_key === 'string' ? input.api_key : '';
  if (!PROVIDER_IDS.has(providerId)) fail('MODEL_PROVIDER_INVALID');
  if (!MODEL_ID_PATTERN.test(modelId)) fail('MODEL_ID_INVALID');
  if (apiKey.length < 8 || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) fail('MODEL_KEY_INVALID');
  if (input.consent !== true || input.consent_version !== MODEL_CONSENT_VERSION) {
    fail('MODEL_CONSENT_REQUIRED');
  }
  return { providerId, modelId, apiKey };
}

function runtimeEnv(stateDir, configPath) {
  return {
    ...process.env,
    HOME: stateDir.replace(/\/\.openclaw$/, ''),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  };
}

export function createOpenClawRunner(options = {}) {
  const bin = options.bin || process.env.BRAINX_OPENCLAW_BIN || '/usr/local/bin/openclaw';
  const stateDir = options.stateDir || process.env.BRAINX_OPENCLAW_STATE_DIR || '/var/lib/brainx/.openclaw';
  const configPath = options.configPath || process.env.BRAINX_OPENCLAW_CONFIG_PATH || `${stateDir}/openclaw.json`;
  const timeoutMs = options.timeoutMs || 12_000;
  const maxOutputBytes = options.maxOutputBytes || 64 * 1024;
  const spawnImpl = options.spawnImpl || spawn;
  const runAs = options.runAs ?? process.env.BRAINX_OPENCLAW_RUN_AS ?? '';
  if (runAs && !/^[a-z_][a-z0-9_-]{0,31}$/.test(runAs)) fail('OPENCLAW_CONFIG_INVALID');

  return {
    call(args, { stdin = '' } = {}) {
      if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) fail('OPENCLAW_CONFIG_INVALID');
      return new Promise((resolve, reject) => {
        const elevated = runAs && typeof process.getuid === 'function' && process.getuid() === 0;
        const command = elevated ? '/usr/sbin/runuser' : bin;
        const argv = elevated ? ['-u', runAs, '--', bin, ...args] : args;
        let stdout = '';
        let stderr = '';
        let total = 0;
        let settled = false;
        const child = spawnImpl(command, argv, {
          env: runtimeEnv(stateDir, configPath), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        });
        let timer;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error); else resolve(value);
        };
        const collect = (target) => (chunk) => {
          total += chunk.length;
          if (total > maxOutputBytes) {
            child.kill('SIGKILL');
            finish(new PersonalModelError('OPENCLAW_OUTPUT_LIMIT'));
            return;
          }
          if (target === 'stdout') stdout += chunk.toString('utf8');
          else stderr += chunk.toString('utf8');
        };
        child.stdout.on('data', collect('stdout'));
        child.stderr.on('data', collect('stderr'));
        child.on('error', (error) => finish(new PersonalModelError('OPENCLAW_UNAVAILABLE', { cause: error })));
        child.on('close', (code) => {
          if (code === 0) finish(null, { stdout, stderr });
          else finish(new PersonalModelError('OPENCLAW_COMMAND_FAILED'));
        });
        timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new PersonalModelError('OPENCLAW_TIMEOUT'));
        }, timeoutMs);
        child.stdin.write(stdin);
        child.stdin.end();
      });
    },
  };
}

function safeJson(value) {
  try { return JSON.parse(value); }
  catch (error) { fail('OPENCLAW_UNAVAILABLE', error); }
}

function publicRow(row, agentReady = true) {
  return {
    schema_version: 'personal_model_profile.v1',
    ready: agentReady && row?.status === 'ACTIVE',
    agent_ready: agentReady,
    provider_id: row?.provider_id || null,
    model_id: row?.model_id || null,
    status: row?.status || 'UNCONFIGURED',
    consent_version: row?.consent_version || MODEL_CONSENT_VERSION,
    consented_at: row?.consented_at || null,
    configured_at: row?.configured_at || null,
    providers: PERSONAL_MODEL_PROVIDERS,
  };
}

export function createPersonalModelService(options) {
  const { db } = options;
  const cli = options.cli || createOpenClawRunner(options);
  const enabled = options.enabled ?? process.env.BRAINX_PERSONAL_MODELS_ENABLED === '1';
  const accountId = options.accountId || process.env.BRAINX_OPENCLAW_FEISHU_ACCOUNT_ID || 'mia';
  const clock = options.now || (() => new Date().toISOString());
  const busy = new Set();
  const requireEnabled = () => { if (!enabled) fail('MODEL_CONFIG_DISABLED'); };
  const rowFor = (consultantId) => db.prepare(
    'SELECT * FROM consultant_model_profiles WHERE consultant_id=?',
  ).get(consultantId);

  async function resolveAgent(identity) {
    requireEnabled();
    const bound = db.prepare(`SELECT 1 FROM feishu_identity_bindings
      WHERE consultant_id=? AND channel_account_id=? AND open_id=? AND binding_status='ACTIVE'`)
      .get(identity.consultantId, accountId, identity.openId);
    if (!bound) fail('PERSONAL_AGENT_NOT_READY');
    let bindings;
    let agents;
    try {
      bindings = safeJson((await cli.call(['config', 'get', 'bindings', '--json'])).stdout);
      agents = safeJson((await cli.call(['config', 'get', 'agents.list', '--json'])).stdout);
    } catch (error) {
      if (error instanceof PersonalModelError && error.code === 'PERSONAL_AGENT_NOT_READY') throw error;
      fail('OPENCLAW_UNAVAILABLE', error);
    }
    const route = Array.isArray(bindings) && bindings.find((item) => item?.match?.channel === 'feishu'
      && item.match.accountId === accountId && item.match.peer?.kind === 'direct'
      && item.match.peer.id === identity.openId);
    const index = Array.isArray(agents) ? agents.findIndex((item) => item?.id === route?.agentId) : -1;
    if (!route?.agentId || index < 0) fail('PERSONAL_AGENT_NOT_READY');
    return { agentId: route.agentId, agentIndex: index };
  }

  function savePending(identity, agentId, input, at) {
    const profileId = `${input.providerId}:brainx-personal`;
    db.prepare(`INSERT INTO consultant_model_profiles
      (consultant_id,feishu_account_id,agent_id,provider_id,model_id,profile_id,status,
       consent_version,consented_at,configured_at,disabled_at,last_error_code,updated_at)
      VALUES (?,?,?,?,?,?,'PENDING',?,?,NULL,NULL,NULL,?)
      ON CONFLICT(consultant_id) DO UPDATE SET feishu_account_id=excluded.feishu_account_id,
       agent_id=excluded.agent_id,provider_id=excluded.provider_id,model_id=excluded.model_id,
       profile_id=excluded.profile_id,status='PENDING',consent_version=excluded.consent_version,
       consented_at=excluded.consented_at,configured_at=NULL,disabled_at=NULL,last_error_code=NULL,
       updated_at=excluded.updated_at`).run(identity.consultantId, accountId, agentId,
      input.providerId, input.modelId, profileId, MODEL_CONSENT_VERSION, at, at);
    return profileId;
  }

  async function configure(identity, rawInput) {
    requireEnabled();
    const input = validateModelInput(rawInput);
    if (busy.has(identity.consultantId)) fail('MODEL_CONFIG_BUSY');
    busy.add(identity.consultantId);
    let previous;
    let agent;
    try {
      agent = await resolveAgent(identity);
      previous = rowFor(identity.consultantId);
      const at = clock();
      const profileId = savePending(identity, agent.agentId, input, at);
      await cli.call(['config', 'set', `agents.list[${agent.agentIndex}].model`,
        `${input.providerId}/${input.modelId}`]);
      await cli.call(['models', 'auth', '--agent', agent.agentId, 'paste-api-key',
        '--provider', input.providerId, '--profile-id', profileId], { stdin: `${input.apiKey}\n` });
      await cli.call(['models', 'auth', 'order', 'set', '--agent', agent.agentId,
        '--provider', input.providerId, profileId]);
      db.prepare(`UPDATE consultant_model_profiles SET status='ACTIVE',configured_at=?,
        last_error_code=NULL,updated_at=? WHERE consultant_id=?`).run(at, at, identity.consultantId);
      return publicRow(rowFor(identity.consultantId));
    } catch (error) {
      const code = error instanceof PersonalModelError ? error.code : 'MODEL_CONFIG_FAILED';
      if (agent && previous?.status === 'ACTIVE') {
        try {
          await cli.call(['config', 'set', `agents.list[${agent.agentIndex}].model`,
            `${previous.provider_id}/${previous.model_id}`]);
        } catch { /* last_error_code below forces operator inspection */ }
      }
      if (agent) db.prepare(`UPDATE consultant_model_profiles SET status='ERROR',
        last_error_code=?,updated_at=? WHERE consultant_id=?`).run(code, clock(), identity.consultantId);
      if (error instanceof PersonalModelError) throw error;
      fail('MODEL_CONFIG_FAILED', error);
    } finally {
      busy.delete(identity.consultantId);
    }
  }

  async function getStatus(identity) {
    const agent = await resolveAgent(identity);
    const row = rowFor(identity.consultantId);
    if (row && row.agent_id !== agent.agentId) fail('PERSONAL_AGENT_NOT_READY');
    return publicRow(row);
  }

  return { configure, getStatus, resolveAgent };
}
