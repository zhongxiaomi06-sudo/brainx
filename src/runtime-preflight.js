/** 三份生产环境文件的一致性校验；只返回变量名和错误码，不返回任何值。 */

const PLACEHOLDER = /(replace-|must-equal-|cli_replace|ou_replace|oc_replace)/i;
const ID = /^(?:ou|oc)_[A-Za-z0-9_-]+$/;
const REQUIRED_SOURCING_TOOLS = Object.freeze([
  'brainx_openmai_search',
  'brainx_supermai_scout',
  'brainx_candidate_report',
]);

function requireKeys(source, names, file, errors) {
  for (const name of names) {
    if (!String(source[name] || '').trim()) errors.push(`${file}:${name}:MISSING`);
    else if (PLACEHOLDER.test(String(source[name]))) errors.push(`${file}:${name}:PLACEHOLDER`);
  }
}

function same(left, leftName, right, rightName, errors) {
  if (left && right && left !== right) errors.push(`${leftName}:${rightName}:MISMATCH`);
}

function secret(value, name, errors) {
  if (value && Buffer.byteLength(value) < 32) errors.push(`${name}:TOO_SHORT`);
}

export function validateRuntimeConfig({ agent = {}, worker = {}, openclaw = {} }) {
  const errors = [];
  requireKeys(agent, [
    'BRAINX_AGENT_GATEWAY_TOKEN', 'BRAINX_AGENT_ASSERTION_SECRET', 'BRAINX_AGENT_AUDIT_KEY',
    'BRAINX_AGENT_FEISHU_APP_KEYS_JSON', 'BRAINX_AGENT_ADMIN_ID', 'BRAINX_AGENT_ADMIN_ALLOWLIST',
    'BRAINX_DB', 'BRAINX_MYSQL_HOST', 'BRAINX_MYSQL_DATABASE', 'BRAINX_MYSQL_USER',
    'BRAINX_MYSQL_PASSWORD', 'BRAINX_MYSQL_SSL',
    'BRAINX_FEISHU_CREDENTIALS_FROM_OPENCLAW', 'BRAINX_OPENCLAW_CONFIG_PATH',
    'BRAINX_FEISHU_DOC_BASE_URL',
  ], 'agent.env', errors);
  requireKeys(worker, [
    'BRAINX_DB', 'BRAINX_BASE_URL', 'BRAINX_FEISHU_APP_ID', 'BRAINX_FEISHU_APP_SECRET',
    'BRAINX_MYSQL_HOST', 'BRAINX_MYSQL_DATABASE', 'BRAINX_MYSQL_USER', 'BRAINX_MYSQL_PASSWORD',
    'BRAINX_MYSQL_SSL',
  ], 'worker.env', errors);
  if (worker.BRAINX_RELOOP_SYNC_ENABLED === '1') requireKeys(worker, [
    'BRAINX_TENANT_ID', 'BRAINX_RELOOP_CONSULTANT_ID', 'BRAINX_RELOOP_SOURCE_OWNER_ID',
    'BRAINX_RELOOP_EXPECTED_BOUND_NAME',
  ], 'worker.env', errors);
  requireKeys(openclaw, [
    'OPENCLAW_GATEWAY_TOKEN', 'BRAINX_FEISHU_APP_ID', 'BRAINX_FEISHU_APP_SECRET',
    'BRAINX_BASE_URL', 'BRAINX_AGENT_GATEWAY_TOKEN', 'BRAINX_AGENT_ASSERTION_SECRET',
    'STEPFUN_API_KEY',
    ...Array.from({ length: 9 }, (_, index) => `BRAINX_FEISHU_ALLOWED_OPEN_ID_${index + 1}`),
    ...Array.from({ length: 3 }, (_, index) => `BRAINX_FEISHU_ALLOWED_CHAT_ID_${index + 1}`),
  ], 'openclaw.env', errors);

  for (const [name, value] of [
    ['agent.env:BRAINX_AGENT_GATEWAY_TOKEN', agent.BRAINX_AGENT_GATEWAY_TOKEN],
    ['agent.env:BRAINX_AGENT_ASSERTION_SECRET', agent.BRAINX_AGENT_ASSERTION_SECRET],
    ['agent.env:BRAINX_AGENT_AUDIT_KEY', agent.BRAINX_AGENT_AUDIT_KEY],
    ['openclaw.env:OPENCLAW_GATEWAY_TOKEN', openclaw.OPENCLAW_GATEWAY_TOKEN],
    ['openclaw.env:BRAINX_FEISHU_APP_SECRET', openclaw.BRAINX_FEISHU_APP_SECRET],
    ['openclaw.env:STEPFUN_API_KEY', openclaw.STEPFUN_API_KEY],
  ]) secret(value, name, errors);

  const independent = [agent.BRAINX_AGENT_GATEWAY_TOKEN, agent.BRAINX_AGENT_ASSERTION_SECRET,
    agent.BRAINX_AGENT_AUDIT_KEY, openclaw.OPENCLAW_GATEWAY_TOKEN].filter(Boolean);
  if (new Set(independent).size !== independent.length) errors.push('runtime:SECRETS_REUSED');
  same(agent.BRAINX_AGENT_GATEWAY_TOKEN, 'agent.env:BRAINX_AGENT_GATEWAY_TOKEN',
    openclaw.BRAINX_AGENT_GATEWAY_TOKEN, 'openclaw.env:BRAINX_AGENT_GATEWAY_TOKEN', errors);
  same(agent.BRAINX_AGENT_ASSERTION_SECRET, 'agent.env:BRAINX_AGENT_ASSERTION_SECRET',
    openclaw.BRAINX_AGENT_ASSERTION_SECRET, 'openclaw.env:BRAINX_AGENT_ASSERTION_SECRET', errors);
  same(agent.BRAINX_DB, 'agent.env:BRAINX_DB', worker.BRAINX_DB, 'worker.env:BRAINX_DB', errors);
  same(worker.BRAINX_BASE_URL, 'worker.env:BRAINX_BASE_URL',
    openclaw.BRAINX_BASE_URL, 'openclaw.env:BRAINX_BASE_URL', errors);
  same(worker.BRAINX_FEISHU_APP_ID, 'worker.env:BRAINX_FEISHU_APP_ID',
    openclaw.BRAINX_FEISHU_APP_ID, 'openclaw.env:BRAINX_FEISHU_APP_ID', errors);
  same(worker.BRAINX_FEISHU_APP_SECRET, 'worker.env:BRAINX_FEISHU_APP_SECRET',
    openclaw.BRAINX_FEISHU_APP_SECRET, 'openclaw.env:BRAINX_FEISHU_APP_SECRET', errors);

  try {
    const url = new URL(openclaw.BRAINX_BASE_URL);
    if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
      errors.push('openclaw.env:BRAINX_BASE_URL:NOT_PRODUCTION_HTTPS');
    }
  } catch { if (openclaw.BRAINX_BASE_URL) errors.push('openclaw.env:BRAINX_BASE_URL:INVALID'); }
  if (openclaw.BRAINX_FEISHU_APP_ID && !/^cli_[A-Za-z0-9]+$/.test(openclaw.BRAINX_FEISHU_APP_ID)) {
    errors.push('openclaw.env:BRAINX_FEISHU_APP_ID:INVALID');
  }
  if (agent.BRAINX_FEISHU_CREDENTIALS_FROM_OPENCLAW
      && agent.BRAINX_FEISHU_CREDENTIALS_FROM_OPENCLAW !== '1') {
    errors.push('agent.env:BRAINX_FEISHU_CREDENTIALS_FROM_OPENCLAW:INVALID');
  }
  if (agent.BRAINX_OPENCLAW_CONFIG_PATH && !agent.BRAINX_OPENCLAW_CONFIG_PATH.startsWith('/')) {
    errors.push('agent.env:BRAINX_OPENCLAW_CONFIG_PATH:INVALID');
  }
  try {
    const docUrl = new URL(agent.BRAINX_FEISHU_DOC_BASE_URL);
    if (docUrl.protocol !== 'https:' || !docUrl.hostname.endsWith('.feishu.cn')) {
      errors.push('agent.env:BRAINX_FEISHU_DOC_BASE_URL:INVALID');
    }
  } catch {
    if (agent.BRAINX_FEISHU_DOC_BASE_URL) {
      errors.push('agent.env:BRAINX_FEISHU_DOC_BASE_URL:INVALID');
    }
  }

  const people = Array.from({ length: 9 }, (_, index) =>
    openclaw[`BRAINX_FEISHU_ALLOWED_OPEN_ID_${index + 1}`]).filter(Boolean);
  const chats = Array.from({ length: 3 }, (_, index) =>
    openclaw[`BRAINX_FEISHU_ALLOWED_CHAT_ID_${index + 1}`]).filter(Boolean);
  if (people.some((value) => !ID.test(value) || !value.startsWith('ou_'))) {
    errors.push('openclaw.env:ALLOWED_OPEN_IDS:INVALID');
  }
  if (new Set(people).size !== people.length) errors.push('openclaw.env:ALLOWED_OPEN_IDS:DUPLICATE');
  if (chats.some((value) => !ID.test(value) || !value.startsWith('oc_'))) {
    errors.push('openclaw.env:ALLOWED_CHAT_IDS:INVALID');
  }

  const admins = String(agent.BRAINX_AGENT_ADMIN_ALLOWLIST || '').split(',').map(v => v.trim());
  if (agent.BRAINX_AGENT_ADMIN_ID && !admins.includes(agent.BRAINX_AGENT_ADMIN_ID)) {
    errors.push('agent.env:BRAINX_AGENT_ADMIN_ALLOWLIST:ADMIN_MISSING');
  }
  try {
    const keys = JSON.parse(agent.BRAINX_AGENT_FEISHU_APP_KEYS_JSON || '{}');
    if (!keys.mia) errors.push('agent.env:BRAINX_AGENT_FEISHU_APP_KEYS_JSON:MIA_MISSING');
    for (const value of Object.values(keys)) secret(String(value || ''),
      'agent.env:BRAINX_AGENT_FEISHU_APP_KEYS_JSON', errors);
  } catch { errors.push('agent.env:BRAINX_AGENT_FEISHU_APP_KEYS_JSON:INVALID_JSON'); }

  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

export function validateOpenClawToolPolicy(config = {}) {
  const allow = [config.tools?.allow, config.tools?.alsoAllow]
    .filter(Array.isArray)
    .flat();
  const errors = REQUIRED_SOURCING_TOOLS
    .filter((tool) => !allow.includes(tool))
    .map((tool) => `openclaw.json:tools:${tool}:MISSING`);
  return { ok: errors.length === 0, errors };
}
