#!/usr/bin/env node
/** brainx-lark-backfill — 用户身份 lark-cli 历史消息回填 CLI（specs/022 信号层第二批）。
 *
 * 输入：lark-cli `im +chat-messages-list --as user --page-all` 的原始 JSON 文件
 *       （目录批处理：--dir <path>；单文件：--file <path>）。
 * 写入：lark_messages（origin='backfill'，message_id 主键幂等，INSERT OR IGNORE）。
 * 纪律：dry-run 默认——不加 --apply 只统计不落库；先跑 migration 0056 加 origin 列。
 *
 * 用法：node bin/brainx-lark-backfill.mjs --dir /tmp/batch2 [--apply]
 * 成功 stdout 一行 JSON 摘要；失败 stderr + 退出码 1。
 */
import '../src/env.js';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now } from '../src/db.js';
import { mapLarkCliMessage, parseLarkCliOutput, backfillRows } from '../src/lark-backfill.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const ixDir = argv.indexOf('--dir');
const ixFile = argv.indexOf('--file');

let files = [];
if (ixDir !== -1) {
  const dir = argv[ixDir + 1];
  files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
} else if (ixFile !== -1) {
  files = [argv[ixFile + 1]];
} else {
  console.error('用法：brainx-lark-backfill.mjs (--dir <目录> | --file <文件>) [--apply]');
  process.exit(1);
}
if (!files.length) {
  console.error('没有可处理的 .json 文件');
  process.exit(1);
}

const dbPath = process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');

// 前置：origin 列必须已存在（migration 0056）
const cols = db.prepare("PRAGMA table_info(lark_messages)").all().map((c) => c.name);
if (!cols.includes('origin')) {
  console.error('lark_messages 缺少 origin 列：先执行 migrations/0056_lark_messages_origin.sql');
  process.exit(1);
}

const rows = [];
const perFile = [];
let parseFail = 0;
for (const f of files) {
  try {
    const msgs = parseLarkCliOutput(readFileSync(f, 'utf8'));
    const mapped = msgs.map(mapLarkCliMessage).filter(Boolean);
    rows.push(...mapped);
    perFile.push({ file: f.split('/').pop(), raw: msgs.length, mapped: mapped.length });
  } catch (e) {
    parseFail += 1;
    console.error(`跳过 ${f}: ${e.message}`);
  }
}

const runAt = now();
let result = { total: rows.length, inserted: 0 };
if (apply) {
  db.exec('BEGIN');
  try {
    result = backfillRows(db, rows);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`回填失败，已回滚：${e.message}`);
    process.exit(1);
  }
} else if (rows.length) {
  // dry-run：用内存库实测插入量（主键冲突计入不增），保证统计口径与 --apply 一致
  const mem = new DatabaseSync(':memory:');
  mem.exec(`CREATE TABLE lark_messages (
    message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, message_type TEXT, text TEXT,
    mentions_json TEXT, create_time TEXT NOT NULL, received_at TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'gateway')`);
  result = backfillRows(mem, rows);
}

console.log(JSON.stringify({
  mode: apply ? 'apply' : 'dry-run',
  files: files.length,
  parse_fail: parseFail,
  mapped: result.total,
  inserted: result.inserted,
  duplicates: result.total - result.inserted,
  run_at: runAt,
}));
