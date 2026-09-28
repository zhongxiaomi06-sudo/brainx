#!/usr/bin/env node
/** brainx-backup — 生产库每日一致性快照（specs/021-data-governance US1）。
 *
 * 纪律：
 *  - 快照用 `VACUUM INTO`（WAL 安全的在线一致性方式；禁止直接 cp 数据文件，
 *    参照 scripts/pull-cloud-data.mjs 的远端快照做法）；
 *  - 源库以 readOnly 打开，本脚本对生产库零写入；
 *  - 快照后自检：只读打开快照，`PRAGMA quick_check` 必须全 ok，
 *    且 workflow_event_log / lark_messages / job_facts 行数与源库一致，否则判失败；
 *  - 滚动保留：文件名带日期（brainx-YYYYMMDD-HHMMSS.db），删除超过
 *    BRAINX_BACKUP_KEEP_DAYS（默认 14）天的旧快照；
 *  - 重叠保护：备份目录下 `.backup.lock` 用 O_EXCL 创建，已有实例在跑则退出码 75。
 *
 * env：BRAINX_DB_PATH（缺省 data/brainx.db）、BRAINX_BACKUP_DIR（缺省 data/backups）、
 *      BRAINX_BACKUP_KEEP_DAYS（缺省 14）。
 * 用法：node bin/brainx-backup.mjs
 *   成功：stdout 打一行 JSON 摘要；失败：stderr 打原因 + 非零退出码（锁占用 = 75，其余 = 1）。
 */
import '../src/env.js';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LOCK_EXIT_CODE = 75; // EX_TEMPFAIL：systemd/调用方据此区分「稍后重试」与真失败
export const LOCK_FILE = '.backup.lock';
export const SNAPSHOT_RE = /^brainx-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;
/** 自检对照表：账本 + 原文 + 职位事实（缺一即判快照不可用）。 */
export const CHECK_TABLES = ['workflow_event_log', 'lark_messages', 'job_facts'];

export class LockHeldError extends Error {
  constructor(lockPath) {
    super(`另一备份实例正在运行（锁文件存在：${lockPath}）`);
    this.code = 'LOCK_HELD';
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地墙钟时间戳：{ day: 'YYYYMMDD', stamp: 'YYYYMMDD-HHMMSS' }（快照/归档文件名共用）。 */
export function timestampParts(d = new Date()) {
  const day = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return { day, stamp: `${day}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}` };
}

/** O_EXCL 抢锁；成功返回释放函数（unlink）。 */
export function acquireLock(backupDir) {
  const lockPath = join(backupDir, LOCK_FILE);
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e?.code === 'EEXIST') throw new LockHeldError(lockPath);
    throw e;
  }
  return () => {
    try { closeSync(fd); } catch { /* 已关闭则忽略 */ }
    try { unlinkSync(lockPath); } catch { /* 已被清理则忽略 */ }
  };
}

/** 表行数；表不存在（老库）按 0 计，不让自检因缺表崩掉。 */
function tableCount(db, table) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!exists) return 0;
  return db.prepare(`SELECT COUNT(*) n FROM "${table}"`).get().n;
}

/** 删除备份目录里超过 keepDays 天的旧快照（按文件名日期，不看 mtime）。 */
export function pruneSnapshots(backupDir, keepDays, now = new Date()) {
  const pruned = [];
  for (const name of readdirSync(backupDir)) {
    const m = SNAPSHOT_RE.exec(name);
    if (!m) continue; // 只碰自己命名规范的文件，其他文件一律不动
    const fileDate = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (now.getTime() - fileDate > keepDays * 86400e3) {
      unlinkSync(join(backupDir, name));
      pruned.push(name);
    }
  }
  return pruned;
}

/**
 * 跑一次完整备份：快照 → 自检 → 滚动清理。成功返回摘要对象，失败抛错。
 * retention 脚本（bin/brainx-ledger-retention.mjs）执行前复用本函数留档。
 */
export function runBackup({ dbPath, backupDir, keepDays = 14, now = new Date() }) {
  mkdirSync(backupDir, { recursive: true });
  const release = acquireLock(backupDir);
  let snapshot = null;
  try {
    const src = new DatabaseSync(dbPath, { readOnly: true });
    src.exec('PRAGMA busy_timeout = 10000');
    // VACUUM INTO 目标必须不存在。锁文件只挡并发，挡不了同秒先后两跑撞名——
    // 撞到就等下一秒重新取时间戳（最多 5 次），绝不覆盖已有快照。
    snapshot = join(backupDir, `brainx-${timestampParts(now).stamp}.db`);
    for (let i = 0; existsSync(snapshot) && i < 5; i++) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100);
      snapshot = join(backupDir, `brainx-${timestampParts().stamp}.db`);
    }
    if (existsSync(snapshot)) throw new Error(`快照目标已存在且等待后仍撞名：${snapshot}`);
    src.exec(`VACUUM INTO '${snapshot.replaceAll("'", "''")}'`);
    const counts = Object.fromEntries(CHECK_TABLES.map((t) => [t, tableCount(src, t)]));
    src.close();

    // —— 自检：只读打开快照，quick_check + 行数对照 ——
    const snap = new DatabaseSync(snapshot, { readOnly: true });
    const quickCheck = snap.prepare('PRAGMA quick_check').all();
    const snapCounts = Object.fromEntries(CHECK_TABLES.map((t) => [t, tableCount(snap, t)]));
    snap.close();
    const badCheck = quickCheck.find((r) => r.quick_check !== 'ok');
    if (badCheck) throw new Error(`快照完整性校验失败：quick_check=${badCheck.quick_check}`);
    const mismatch = CHECK_TABLES.filter((t) => snapCounts[t] !== counts[t]);
    if (mismatch.length) {
      throw new Error(`快照行数与源库不一致：${mismatch.map((t) => `${t} 源=${counts[t]} 快照=${snapCounts[t]}`).join('，')}`);
    }

    const pruned = pruneSnapshots(backupDir, keepDays, now);
    return { snapshot, counts, quick_check: 'ok', keep_days: keepDays, pruned };
  } catch (e) {
    // 失败不留半成品快照，避免后续恢复演练误拿坏文件。
    if (snapshot) try { unlinkSync(snapshot); } catch { /* 不存在则忽略 */ }
    throw e;
  } finally {
    release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dbPath = process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
  const backupDir = process.env.BRAINX_BACKUP_DIR || join(ROOT, 'data', 'backups');
  const keepDays = Number(process.env.BRAINX_BACKUP_KEEP_DAYS) || 14;
  try {
    const summary = runBackup({ dbPath, backupDir, keepDays });
    console.log(JSON.stringify({ ok: true, db: dbPath, ...summary }));
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.error(`[backup] ${e.message}，本次跳过（退出码 ${LOCK_EXIT_CODE}）`);
      process.exit(LOCK_EXIT_CODE);
    }
    console.error(`[backup] 备份失败：${e?.message || e}`);
    process.exit(1);
  }
}
