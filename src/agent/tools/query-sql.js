/** SQLite 只读直查(sql-guard 守门 + readOnly 句柄双保险;BRAINX_AGENT_SQL=0 时整个工具不注册)。 */
import { guardSelect, SqlGuardError } from '../sql-guard.js';

const CELL_CAP = 500;

export default {
  name: 'query_sql',
  description: '对 BrainX SQLite 决策库执行只读 SQL(仅 SELECT/WITH/EXPLAIN 单语句,自动 LIMIT 500)。适合自定义统计/联表/历史追溯。表结构先加载 brainx-data-explorer 技能。',
  parameters: { type: 'object', required: ['sql'], properties: {
    sql: { type: 'string', description: '一条只读 SELECT 语句' } } },
  run: ({ sql }, ctx) => {
    let statement;
    try {
      statement = guardSelect(sql);
    } catch (e) {
      if (e instanceof SqlGuardError) return { error: 'SQL_GUARD', message: e.message };
      throw e;
    }
    let db;
    try {
      db = ctx.readDb();
    } catch {
      return { error: 'DB_UNAVAILABLE', message: '只读库句柄不可用' };
    }
    const rows = db.prepare(statement).all().map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        const s = typeof v === 'string' ? v : JSON.stringify(v);
        out[k] = s && s.length > CELL_CAP ? s.slice(0, CELL_CAP) + '…' : v;
      }
      return out;
    });
    return { rows, row_count: rows.length, truncated_to: 500 };
  },
};
