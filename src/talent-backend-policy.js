/** 人才库运行期后端选择：显式配置、只读就绪校验、失败关闭。 */
import { talentMigrationNames } from './talent-migrations.js';

const REQUIRED_CREDENTIALS = [
  'BRAINX_MYSQL_USER', 'BRAINX_MYSQL_PASSWORD', 'BRAINX_MYSQL_DATABASE',
];

const REQUIRED_TABLES = [
  'user', 'talent', 'tag', 'talent_tag', 'resume', 'position', 'match_record',
  'talent_schema_migrations', 'talent_access_grants', 'candidate_source_links',
  'candidate_documents', 'candidate_fact_versions', 'candidate_fact_evidence',
  'job_criteria_versions', 'match_runs', 'candidate_job_matches',
  'source_sync_cursors', 'job_access_grants',
];

export class TalentBackendError extends Error {
  constructor(code, message, { connected = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TalentBackendError';
    this.code = code;
    this.connected = connected;
  }
}

const failure = (code, message, options) => new TalentBackendError(code, message, options);

function guardMysqlOperations(mysqlBackend) {
  return new Proxy(mysqlBackend, { get(target, property, receiver) {
    const value = Reflect.get(target, property, receiver);
    if (typeof value !== 'function') return value;
    return async (...args) => {
      try { return await value.apply(target, args); }
      catch (cause) {
        if (cause?.code?.startsWith?.('TALENT_')) throw cause;
        throw failure('TALENT_MYSQL_OPERATION_FAILED', '人才库操作失败',
          { connected: false, cause });
      }
    };
  } });
}

export function resolveTalentBackendMode(env = process.env) {
  const mode = String(env.BRAINX_TALENT_BACKEND || '').trim().toLowerCase();
  if (!mode) throw failure('TALENT_BACKEND_NOT_CONFIGURED', '人才库后端未配置');
  if (!['mysql', 'memory'].includes(mode)) {
    throw failure('TALENT_BACKEND_INVALID', '人才库后端配置无效');
  }
  if (mode === 'memory' && env.BRAINX_ALLOW_VOLATILE_TALENT !== '1') {
    throw failure('TALENT_VOLATILE_MEMORY_FORBIDDEN', '易失人才库未显式启用');
  }
  return mode;
}

export function configuredTalentBackendLabel(env = process.env) {
  const mode = String(env.BRAINX_TALENT_BACKEND || '').trim().toLowerCase();
  return ['mysql', 'memory'].includes(mode) ? mode : 'unconfigured';
}

export async function assertTalentSchemaReady(db) {
  try {
    const applied = await db.withMysql(async (conn) => {
      for (const table of REQUIRED_TABLES) {
        await conn.execute(`SELECT 1 FROM \`${table}\` LIMIT 0`);
      }
      const [rows] = await conn.execute(
        'SELECT name FROM talent_schema_migrations ORDER BY name');
      return new Set(rows.map((row) => row.name));
    });
    const missing = talentMigrationNames().filter((name) => !applied.has(name));
    if (missing.length) throw new Error('migration history incomplete');
  } catch (cause) {
    if (cause?.code === 'TALENT_SCHEMA_NOT_READY') throw cause;
    throw failure('TALENT_SCHEMA_NOT_READY', '人才库结构未就绪', { connected: true, cause });
  }
}

export async function connectTalentBackend({
  env = process.env,
  memoryBackend,
  makeMysqlBackend,
  loadDb = () => import('./db.js'),
  verifySchema = assertTalentSchemaReady,
}) {
  const mode = resolveTalentBackendMode(env);
  if (mode === 'memory') return memoryBackend;
  if (REQUIRED_CREDENTIALS.some((key) => !String(env[key] || '').trim())) {
    throw failure('TALENT_CREDENTIALS_MISSING', '人才库连接凭据不完整');
  }
  let db;
  try {
    db = await loadDb();
    await db.pingMysql();
  } catch (cause) {
    throw failure('TALENT_MYSQL_UNREACHABLE', '人才库暂不可用', { cause });
  }
  try {
    await verifySchema(db);
  } catch (cause) {
    if (cause?.code === 'TALENT_SCHEMA_NOT_READY') throw cause;
    throw failure('TALENT_SCHEMA_NOT_READY', '人才库结构未就绪', { connected: true, cause });
  }
  return guardMysqlOperations(makeMysqlBackend(db));
}
