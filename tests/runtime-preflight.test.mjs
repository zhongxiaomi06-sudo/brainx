import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeConfig } from '../src/runtime-preflight.js';

const value = (char) => char.repeat(64);
function valid() {
  const agent = {
    BRAINX_AGENT_GATEWAY_TOKEN: value('a'), BRAINX_AGENT_ASSERTION_SECRET: value('b'),
    BRAINX_AGENT_AUDIT_KEY: value('c'),
    BRAINX_AGENT_FEISHU_APP_KEYS_JSON: JSON.stringify({ mia: value('d') }),
    BRAINX_AGENT_ADMIN_ID: 'operator-1', BRAINX_AGENT_ADMIN_ALLOWLIST: 'operator-1,operator-2',
    BRAINX_DB: '/opt/brainx/data/brainx.sqlite', BRAINX_MYSQL_HOST: 'db.internal',
    BRAINX_MYSQL_DATABASE: 'brainx_talent', BRAINX_MYSQL_USER: 'brainx_agent_readonly',
    BRAINX_MYSQL_PASSWORD: value('e'), BRAINX_MYSQL_SSL: '1',
  };
  const worker = {
    BRAINX_DB: agent.BRAINX_DB, BRAINX_BASE_URL: 'https://base.example.com',
    BRAINX_FEISHU_APP_ID: 'cli_123456', BRAINX_FEISHU_APP_SECRET: value('f'),
    BRAINX_RELOOP_SYNC_ENABLED: '1', BRAINX_TENANT_ID: 'tenant-1',
    BRAINX_RELOOP_CONSULTANT_ID: 'mia', BRAINX_RELOOP_SOURCE_OWNER_ID: 'owner-1',
    BRAINX_RELOOP_EXPECTED_BOUND_NAME: 'Mia', BRAINX_MYSQL_HOST: 'db.internal',
    BRAINX_MYSQL_DATABASE: 'brainx_talent', BRAINX_MYSQL_USER: 'brainx_worker_runtime',
    BRAINX_MYSQL_PASSWORD: value('g'), BRAINX_MYSQL_SSL: '1',
  };
  const openclaw = {
    OPENCLAW_GATEWAY_TOKEN: value('h'), BRAINX_FEISHU_APP_ID: worker.BRAINX_FEISHU_APP_ID,
    BRAINX_FEISHU_APP_SECRET: worker.BRAINX_FEISHU_APP_SECRET,
    BRAINX_BASE_URL: worker.BRAINX_BASE_URL,
    BRAINX_AGENT_GATEWAY_TOKEN: agent.BRAINX_AGENT_GATEWAY_TOKEN,
    BRAINX_AGENT_ASSERTION_SECRET: agent.BRAINX_AGENT_ASSERTION_SECRET,
    STEPFUN_API_KEY: value('i'),
  };
  for (let index = 1; index <= 6; index++) openclaw[`BRAINX_FEISHU_ALLOWED_OPEN_ID_${index}`] = `ou_user_${index}`;
  for (let index = 1; index <= 3; index++) openclaw[`BRAINX_FEISHU_ALLOWED_CHAT_ID_${index}`] = `oc_group_${index}`;
  return { agent, worker, openclaw };
}

test('运行配置预检接受三份一致且无占位符的最小生产配置', () => {
  assert.deepEqual(validateRuntimeConfig(valid()), { ok: true, errors: [] });
});

test('运行配置预检一次指出 Agent API、身份白名单和回群 worker 的具体配置层', () => {
  const input = valid();
  input.openclaw.BRAINX_AGENT_GATEWAY_TOKEN = 'must-equal-agent.env';
  input.openclaw.STEPFUN_API_KEY = 'replace-stepfun-api-key';
  input.openclaw.BRAINX_AGENT_ASSERTION_SECRET = value('x');
  input.worker.BRAINX_FEISHU_APP_ID = 'cli_other';
  input.worker.BRAINX_BASE_URL = 'http://127.0.0.1:3000';
  input.worker.BRAINX_DB = '/tmp/other.sqlite';
  input.openclaw.BRAINX_FEISHU_ALLOWED_OPEN_ID_6 = 'ou_user_1';
  input.agent.BRAINX_AGENT_ADMIN_ALLOWLIST = 'operator-2';
  const result = validateRuntimeConfig(input);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('openclaw.env:BRAINX_AGENT_GATEWAY_TOKEN:PLACEHOLDER'));
  assert.ok(result.errors.includes('openclaw.env:STEPFUN_API_KEY:PLACEHOLDER'));
  assert.ok(result.errors.some(error => error.endsWith(':BRAINX_AGENT_ASSERTION_SECRET:MISMATCH')));
  assert.ok(result.errors.some(error => error.endsWith(':BRAINX_FEISHU_APP_ID:MISMATCH')));
  assert.ok(result.errors.some(error => error.endsWith(':BRAINX_DB:MISMATCH')));
  assert.ok(result.errors.some(error => error.endsWith(':BRAINX_BASE_URL:MISMATCH')));
  assert.ok(result.errors.includes('openclaw.env:ALLOWED_OPEN_IDS:DUPLICATE'));
  assert.ok(result.errors.includes('agent.env:BRAINX_AGENT_ADMIN_ALLOWLIST:ADMIN_MISSING'));
  assert.equal(JSON.stringify(result).includes(value('a')), false, '报告不得回显任何密钥');
});
