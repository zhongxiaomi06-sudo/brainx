#!/usr/bin/env node
/** brainx-ledger-retention — 高热表保留/归档（specs/021-data-governance US2）。
 *
 * 对象与默认窗口（env 可调，单位天；窗口内一律不动）：
 *   lark_messages        90  BRAINX_RETENTION_LARK_MESSAGES_DAYS   按 create_time
 *   workflow_event_log   90  BRAINX_RETENTION_EVENT_LOG_DAYS       按 occurred_at
 *   openmai_results     180  BRAINX_RETENTION_OPENMAI_DAYS         按 COALESCE(finished_at, started_at)
 *
 * 纪律（与 bin/brainx-retention.mjs 同一口径）：
 *  - 默认 dry-run：只输出各表 scanned/keep/archive 计数对照，对主库零写入；
 *  - --apply 才执行，且执行前先 VACUUM INTO 安全快照到 BRAINX_BACKUP_DIR
 *    （复用 bin/brainx-backup.mjs 的 runBackup，含 quick_check 自检）；
 *  - 归档不是删除：超龄行先写入归档库 data/archive/brainx-archive-YYYYMMDD.db
 *    （按需建同名表，列结构按源库 PRAGMA table_info 重建），再从主库删除；
 *    归档先写、主库后删，崩溃只可能留下重复归档行（INSERT OR REPLACE 幂等吸收），
 *    不会丢数据。重复执行幂等：第二轮 archive 计数为 0。
 *
 * 引用保护（命中任一即不删不搬，SC-004 零误删）：
 *  - lark_messages：被 status='pending' 的 job_facts_drafts / judgment_drafts 引用（message_id）；
 *    或被仍将留在主库的 workflow_event_log.evidence_refs 引用（MVP 口径：LIKE '%"id":"<message_id>"%'，
 *    message_id 里的 LIKE 通配符 _ % \ 已转义，宁可多留不可误删）；
 *  - workflow_event_log：被 pending 草稿引用（event_id），或被 consumer_failures
 *    未 resolved（resolved_at IS NULL）的行引用。
 *
 * env：BRAINX_DB_PATH（缺省 data/brainx.db）、BRAINX_ARCHIVE_DIR（缺省 data/archive）、
 *      BRAINX_BACKUP_DIR / BRAINX_BACKUP_KEEP_DAYS（安全快照，同 brainx-backup）。
 * 用法：node bin/brainx-ledger-retention.mjs [--apply]
 */
import '../src/env.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackup, timestampParts, LockHeldError, LOCK_EXIT_CODE } from './brainx-backup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 表 × 时间列（窗口比较用）。openmai 用完成时间，running 行回退启动时间。 */
export const TABLE_TIME_COL = {
  lark_messages: 'create_time',
  workflow_event_log: 'occurred_at',
  openmai_results: "COALESCE(finished_at, started_at)",
};

export function resolveWindows(env = process.env) {
  return {
    lark_messages: Number(env.BRAINX_RETENTION_LARK_MESSAGES_DAYS) || 90,
    workflow_event_log: Number(env.BRAINX_RETENTION_EVENT_LOG_DAYS) || 90,
    openmai_results: Number(env.BRAINX_RETENTION_OPENMAI_DAYS) || 180,
  };
}

const cutoffIso = (days, now) => new Date(now.getTime() - days * 86400e3).toISOString();

/**
 * 计算保留计划（dry-run 与 --apply 共用同一套临时表，单一口径）。
 * 只建 TEMP 表 + 计数，不写主库。
 */
export function computePlan(db, windows, now = new Date()) {
  const cut = {
    lark_messages: cutoffIso(windows.lark_messages, now),
    workflow_event_log: cutoffIso(windows.workflow_event_log, now),
    openmai_results: cutoffIso(windows.openmai_results, now),
  };
  // 先算事件归档集合：消息保护只看「仍将留在主库的事件」的 evidence_refs。
  db.exec(`
    DROP TABLE IF EXISTS temp.arc_events;
    CREATE TEMP TABLE arc_events AS
      SELECT e.event_id FROM workflow_event_log e
      WHERE e.occurred_at < '${cut.workflow_event_log}'
        AND NOT EXISTS (SELECT 1 FROM job_facts_drafts d
          WHERE d.event_id = e.event_id AND d.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM judgment_drafts jd
          WHERE jd.event_id = e.event_id AND jd.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM consumer_failures cf
          WHERE cf.event_id = e.event_id AND cf.resolved_at IS NULL);
    DROP TABLE IF EXISTS temp.arc_msgs;
    CREATE TEMP TABLE arc_msgs AS
      SELECT m.message_id FROM lark_messages m
      WHERE m.create_time < '${cut.lark_messages}'
        AND NOT EXISTS (SELECT 1 FROM job_facts_drafts d
          WHERE d.message_id = m.message_id AND d.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM judgment_drafts jd
          WHERE jd.message_id = m.message_id AND jd.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM workflow_event_log e
          WHERE e.event_id NOT IN (SELECT event_id FROM arc_events)
            AND e.evidence_refs LIKE '%"id":"'
              || REPLACE(REPLACE(REPLACE(m.message_id, '\\', '\\\\'), '%', '\\%'), '_', '\\_')
              || '"%' ESCAPE '\\');
    DROP TABLE IF EXISTS temp.arc_openmai;
    CREATE TEMP TABLE arc_openmai AS
      SELECT project_id, consultant_id FROM openmai_results
      WHERE COALESCE(finished_at, started_at) < '${cut.openmai_results}';
  `);
  const n = (sql) => db.prepare(sql).get().n;
  const tables = {};
  for (const [table, arc] of [['lark_messages', 'arc_msgs'], ['workflow_event_log', 'arc_events'], ['openmai_results', 'arc_openmai']]) {
    const scanned = n(`SELECT COUNT(*) n FROM ${table}`);
    const archive = n(`SELECT COUNT(*) n FROM ${arc}`);
    tables[table] = { window_days: windows[table], cutoff: cut[table], scanned, keep: scanned - archive, archive };
  }
  return { windows, tables };
}

/** 按源库 PRAGMA table_info 重建同名表的 DDL（列/类型/默认值/主键一致；CHECK 等约束不带入归档库）。 */
function createTableSql(db, table) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  const q = (s) => `"${s.replaceAll('"', '""')}"`;
  const defs = cols.map((c) => {
    let s = `${q(c.name)} ${c.type || 'TEXT'}`;
    if (c.notnull) s += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined) s += ` DEFAULT ${c.dflt_value}`;
    return s;
  });
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => q(c.name));
  if (pk.length) defs.push(`PRIMARY KEY (${pk.join(', ')})`);
  return `CREATE TABLE IF NOT EXISTS ${q(table)} (${defs.join(', ')})`;
}

const ARCHIVE_SELECT = {
  lark_messages: `SELECT * FROM lark_messages WHERE message_id IN (SELECT message_id FROM arc_msgs)`,
  workflow_event_log: `SELECT * FROM workflow_event_log WHERE event_id IN (SELECT event_id FROM arc_events)`,
  openmai_results: `SELECT o.* FROM openmai_results o
    JOIN arc_openmai a ON a.project_id = o.project_id AND a.consultant_id = o.consultant_id`,
};

const DELETE_SQL = {
  lark_messages: `DELETE FROM lark_messages WHERE message_id IN (SELECT message_id FROM arc_msgs)`,
  workflow_event_log: `DELETE FROM workflow_event_log WHERE event_id IN (SELECT event_id FROM arc_events)`,
  openmai_results: `DELETE FROM openmai_results WHERE (project_id, consultant_id) IN
    (SELECT project_id, consultant_id FROM arc_openmai)`,
};

/**
 * 执行归档：超龄行写入归档库（INSERT OR REPLACE，幂等）后从主库删除。
 * 须先跑 computePlan（临时表是本函数的输入）；调用前应先做安全快照。
 */
export function applyPlan(db, archivePath) {
  mkdirSync(dirname(archivePath), { recursive: true });
  const arch = new DatabaseSync(archivePath);
  arch.exec('PRAGMA busy_timeout = 5000');
  const archived = {};
  try {
    for (const table of Object.keys(TABLE_TIME_COL)) {
      const rows = db.prepare(ARCHIVE_SELECT[table]).all();
      if (rows.length) {
        arch.exec(createTableSql(db, table));
        const cols = Object.keys(rows[0]);
        const insert = arch.prepare(`INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
          VALUES (${cols.map(() => '?').join(', ')})`);
        for (const row of rows) insert.run(...cols.map((c) => row[c]));
      }
      archived[table] = rows.length;
    }
    // 归档落盘后才删主库；主库删除在一个事务里，失败整体回滚（归档侧靠幂等吸收）。
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const table of Object.keys(TABLE_TIME_COL)) db.exec(DELETE_SQL[table]);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } finally {
    arch.close();
  }
  return archived;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apply = process.argv.includes('--apply');
  const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : undefined; };
  const dbPath = arg('db') || process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
  try {
    // dry-run 用只读连接（零写入可证明）；--apply 才读写。关闭逐连接 FK 强校验：
    // 归档会搬走被 confirmed 草稿引用的事件行（保护口径只含 pending），血缘副本在归档库，
    // 若沿用 openDb 的 foreign_keys=ON 会在删除父行时误拦归档。
    const db = new DatabaseSync(dbPath, { readOnly: !apply, enableForeignKeyConstraints: false });
    db.exec('PRAGMA busy_timeout = 10000');
    const windows = resolveWindows();
    const plan = computePlan(db, windows);
    if (!apply) {
      console.log(JSON.stringify({ dry_run: true, db: dbPath, ...plan }, null, 2));
      console.error('[retention] dry-run：确认计数无误后加 --apply 执行（--apply 会先自动安全快照再归档）');
      process.exit(0);
    }
    // 执行前自动留档（VACUUM INTO + quick_check 自检，复用 brainx-backup 全部纪律）
    const backupDir = process.env.BRAINX_BACKUP_DIR || join(ROOT, 'data', 'backups');
    const snapshot = runBackup({
      dbPath,
      backupDir,
      keepDays: Number(process.env.BRAINX_BACKUP_KEEP_DAYS) || 14,
    });
    const archiveDir = process.env.BRAINX_ARCHIVE_DIR || join(ROOT, 'data', 'archive');
    const archivePath = join(archiveDir, `brainx-archive-${timestampParts().day}.db`);
    const archived = applyPlan(db, archivePath);
    db.close();
    console.log(JSON.stringify({ dry_run: false, db: dbPath, snapshot: snapshot.snapshot, archive_db: archivePath, ...plan, archived }, null, 2));
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.error(`[retention] 安全快照抢锁失败：${e.message}（退出码 ${LOCK_EXIT_CODE}）`);
      process.exit(LOCK_EXIT_CODE);
    }
    console.error(`[retention] 执行失败：${e?.message || e}`);
    process.exit(1);
  }
}
