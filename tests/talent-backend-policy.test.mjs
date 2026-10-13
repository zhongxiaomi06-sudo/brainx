import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  assertTalentSchemaReady,
  connectTalentBackend,
  resolveTalentBackendMode,
} from '../src/talent-backend-policy.js';
import {
  listTalents, resetBackend, talentHealth, upsertTalent, useMemoryBackend,
} from '../src/talent.js';

const MYSQL_ENV = {
  BRAINX_TALENT_BACKEND: 'mysql',
  BRAINX_MYSQL_USER: 'worker',
  BRAINX_MYSQL_PASSWORD: 'secret',
  BRAINX_MYSQL_DATABASE: 'brainx_talent',
};

const ENV_KEYS = [
  'BRAINX_TALENT_BACKEND', 'BRAINX_ALLOW_VOLATILE_TALENT',
  'BRAINX_MYSQL_USER', 'BRAINX_MYSQL_PASSWORD', 'BRAINX_MYSQL_DATABASE',
];

async function withProcessEnv(values, operation) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try { return await operation(); }
  finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetBackend();
  }
}

function rejectsCode(code) {
  return (error) => error?.code === code && !String(error.message).includes('secret');
}

test('后端模式必须显式配置，易失内存还需第二道开关', () => {
  assert.throws(() => resolveTalentBackendMode({}), rejectsCode('TALENT_BACKEND_NOT_CONFIGURED'));
  assert.throws(() => resolveTalentBackendMode({ BRAINX_TALENT_BACKEND: 'auto' }),
    rejectsCode('TALENT_BACKEND_INVALID'));
  assert.throws(() => resolveTalentBackendMode({ BRAINX_TALENT_BACKEND: 'memory' }),
    rejectsCode('TALENT_VOLATILE_MEMORY_FORBIDDEN'));
  assert.equal(resolveTalentBackendMode({ BRAINX_TALENT_BACKEND: 'memory',
    BRAINX_ALLOW_VOLATILE_TALENT: '1' }), 'memory');
  assert.equal(resolveTalentBackendMode(MYSQL_ENV), 'mysql');
});

test('MySQL 缺完整凭据时失败关闭且不加载连接模块', async () => {
  let loaded = false;
  await assert.rejects(connectTalentBackend({
    env: { ...MYSQL_ENV, BRAINX_MYSQL_PASSWORD: '' }, memoryBackend: {},
    makeMysqlBackend: () => ({}), loadDb: async () => { loaded = true; return {}; },
  }), rejectsCode('TALENT_CREDENTIALS_MISSING'));
  assert.equal(loaded, false);
});

test('MySQL 断连不回退内存，也不泄露底层连接错误', async () => {
  const memoryBackend = { writes: 0 };
  await assert.rejects(connectTalentBackend({
    env: MYSQL_ENV, memoryBackend, makeMysqlBackend: () => ({ kind: 'mysql' }),
    loadDb: async () => ({ pingMysql: async () => { throw new Error('connect host=db.internal password=secret'); } }),
  }), rejectsCode('TALENT_MYSQL_UNREACHABLE'));
  assert.equal(memoryBackend.writes, 0);
});

test('schema 校验只读基础表与迁移历史，缺迁移时失败', async () => {
  const statements = [];
  const db = { withMysql: async (operation) => operation({ execute: async (sql) => {
    statements.push(sql);
    if (sql.includes('talent_schema_migrations')) return [[{ name: '0001_candidate_data_v1.mjs' }]];
    return [[], []];
  } }) };
  await assert.rejects(assertTalentSchemaReady(db), rejectsCode('TALENT_SCHEMA_NOT_READY'));
  assert.equal(statements.some((sql) => /CREATE|ALTER|INSERT|UPDATE|DELETE/i.test(sql)), false);

  const readyDb = { withMysql: async (operation) => operation({ execute: async (sql) => {
    statements.push(sql);
    if (sql.includes('talent_schema_migrations')) return [[
      { name: '0001_candidate_data_v1.mjs' }, { name: '0002_job_access_grants.mjs' },
    ]];
    return [[], []];
  } }) };
  await assert.doesNotReject(assertTalentSchemaReady(readyDb));
  assert.equal(statements.some((sql) => /CREATE|ALTER|INSERT|UPDATE|DELETE/i.test(sql)), false);
});

test('就绪 MySQL 被采用，运行期不调用建表入口', async () => {
  let schemaChecked = 0;
  let initialized = 0;
  const mysqlBackend = { kind: 'mysql', read: async () => {
    throw new Error('socket host=db.internal password=secret');
  } };
  const selected = await connectTalentBackend({
    env: MYSQL_ENV, memoryBackend: {}, makeMysqlBackend: () => mysqlBackend,
    loadDb: async () => ({
      pingMysql: async () => {},
      initTalentSchema: async () => { initialized++; },
    }),
    verifySchema: async () => { schemaChecked++; },
  });
  assert.equal(selected.kind, 'mysql');
  assert.equal(schemaChecked, 1);
  assert.equal(initialized, 0);
  await assert.rejects(selected.read(), rejectsCode('TALENT_MYSQL_OPERATION_FAILED'));
});

test('人才业务未配置时不产生内存写入，健康状态如实失败', async () => {
  await withProcessEnv({}, async () => {
    resetBackend();
    await assert.rejects(upsertTalent({ name: '不能暂存的人才' }),
      rejectsCode('TALENT_BACKEND_NOT_CONFIGURED'));
    const health = await talentHealth();
    assert.equal(health.ready, false);
    assert.equal(health.connected, false);
    assert.equal(health.error_code, 'TALENT_BACKEND_NOT_CONFIGURED');
    useMemoryBackend();
    assert.deepEqual(await listTalents(), []);
  });
});

test('双重显式启用内存后保留离线演示能力并标记易失', async () => {
  await withProcessEnv({ BRAINX_TALENT_BACKEND: 'memory',
    BRAINX_ALLOW_VOLATILE_TALENT: '1' }, async () => {
    resetBackend();
    assert.equal((await upsertTalent({ name: '离线演示人才' })).created, true);
    const health = await talentHealth();
    assert.equal(health.backend, 'memory');
    assert.equal(health.ready, true);
    assert.equal(health.volatile, true);
    assert.equal(health.degraded, 'VOLATILE_MEMORY');
  });
});

test('人才健康 CLI 在未配置持久化后端时返回非零', () => {
  const env = { ...process.env, BRAINX_ENV_FILE: '/tmp/brainx-missing-env-for-test' };
  for (const key of ENV_KEYS) delete env[key];
  const result = spawnSync(process.execPath, ['scripts/talent-health.mjs'], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /TALENT_BACKEND_NOT_CONFIGURED/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /password=|secret/i);
});

test('人才健康 CLI 不把显式易失内存当成持久化就绪', () => {
  const env = { ...process.env, BRAINX_ENV_FILE: '/tmp/brainx-missing-env-for-test',
    BRAINX_TALENT_BACKEND: 'memory', BRAINX_ALLOW_VOLATILE_TALENT: '1' };
  const result = spawnSync(process.execPath, ['scripts/talent-health.mjs'], {
    cwd: new URL('..', import.meta.url), env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /VOLATILE_MEMORY/);
});
