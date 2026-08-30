/** sql-guard.js — query_sql 工具的纯函数守门:只放行只读单语句 SELECT。
 * 两道防线之一(另一道是 readOnly 句柄);病态查询卡事件循环的残余风险由
 * 行数截断 + BRAINX_AGENT_SQL=0 逃生门兜底(见 tools/query-sql.js)。 */

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|REINDEX|ATTACH|DETACH|PRAGMA|GRANT|TRIGGER|LOAD_EXTENSION|READFILE|WRITEFILE)\b/i;

export class SqlGuardError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'SQL_GUARD';
  }
}

/** 剥掉全部 SQL 注释(-- 行注释与块注释),字符串字面量内的类注释文本原样保留。
 * 全量剥而非只剥行首:堵住「SELECT 1 跟注释再跟 DROP」这类注释偷渡的判定盲区。 */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'") { // SQLite 字符串:单引号,'' 为转义
      out += c; i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { out += sql[i + 1]; i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** 把字符串字面量替换为空串占位('')。结构检查(分号/禁词)在掩码版上做:
 * 字符串里的 ';' 或 'DROP' 只是数据,不该误伤;掩码也防字符串藏禁词绕过。 */
export function maskStrings(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "'") {
      out += "''";
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      continue;
    }
    out += sql[i]; i++;
  }
  return out;
}

/** 校验并返回可安全执行的只读语句(外面包一层 LIMIT 行数闸)。不合规抛 SqlGuardError。 */
export function guardSelect(sql, { rowCap = 500 } = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new SqlGuardError('SQL 不能为空');
  const stripped = stripComments(sql).trim().replace(/;+\s*$/, '');
  if (!stripped) throw new SqlGuardError('SQL 不能为空');
  const masked = maskStrings(stripped);
  if (masked.includes(';')) throw new SqlGuardError('只允许单条语句');
  if (!/^(SELECT|WITH|EXPLAIN)\b/i.test(masked)) {
    throw new SqlGuardError('只允许 SELECT / WITH / EXPLAIN 开头的只读查询');
  }
  if (FORBIDDEN.test(masked)) throw new SqlGuardError('包含禁止的关键字,仅支持只读查询');
  // EXPLAIN 不能包进子查询;其输出行数由查询计划本身约束
  if (/^EXPLAIN\b/i.test(masked)) return stripped;
  return `SELECT * FROM (${stripped}) AS __q LIMIT ${rowCap}`;
}
