#!/usr/bin/env node
/** brainx-client-profiles — 客户画像导入（冷启动第一批，specs/022 client_metrics 画像前置面）。
 *
 * 数据源：GLM 语义清洗聚合产物 client-profiles.json（profile_aggregate.py 产出，
 * 全量阅读 8,131 条 rejected + pending 判定按 chat_id 聚合）。
 * 写入：client_profiles 表 upsert（幂等，重复导入覆盖同 chat_id）。
 * 消费方：推荐匹配/召回过滤按 real_job_count、role_families、companies 读取。
 *
 * 用法：node bin/brainx-client-profiles.mjs --file data/draft-cleanup/client-profiles.json
 * 成功 stdout 一行 JSON 摘要；失败 stderr + 退出码 1。
 */
import '../src/env.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ix = process.argv.indexOf('--file');
const file = ix !== -1 ? process.argv[ix + 1] : join(ROOT, 'data', 'draft-cleanup', 'client-profiles.json');
if (!file) {
  console.error('用法：brainx-client-profiles.mjs --file <client-profiles.json>');
  process.exit(1);
}

const dbPath = process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');

db.exec(`
CREATE TABLE IF NOT EXISTS client_profiles (
  chat_id          TEXT PRIMARY KEY,
  msg_count        INTEGER NOT NULL DEFAULT 0,
  real_job_count   INTEGER NOT NULL DEFAULT 0,
  suspected_count  INTEGER NOT NULL DEFAULT 0,
  companies_json   TEXT NOT NULL DEFAULT '{}',
  role_families_json TEXT NOT NULL DEFAULT '{}',
  role_samples_json  TEXT NOT NULL DEFAULT '[]',
  cities_json      TEXT NOT NULL DEFAULT '{}',
  first_seen       TEXT,
  last_seen        TEXT,
  computed_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_profiles_real ON client_profiles(real_job_count);
`);

const payload = JSON.parse(readFileSync(file, 'utf8'));
const entries = Object.entries(payload.profiles || {});
if (!entries.length) {
  console.error('[profiles] 输入文件无画像数据');
  process.exit(1);
}

const computedAt = now();
const upsert = db.prepare(`
  INSERT INTO client_profiles
    (chat_id, msg_count, real_job_count, suspected_count, companies_json,
     role_families_json, role_samples_json, cities_json, first_seen, last_seen, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    msg_count=excluded.msg_count, real_job_count=excluded.real_job_count,
    suspected_count=excluded.suspected_count, companies_json=excluded.companies_json,
    role_families_json=excluded.role_families_json, role_samples_json=excluded.role_samples_json,
    cities_json=excluded.cities_json, first_seen=excluded.first_seen, last_seen=excluded.last_seen,
    computed_at=excluded.computed_at
`);

db.exec('BEGIN');
let n = 0;
try {
  for (const [chatId, p] of entries) {
    upsert.run(
      chatId, p.msg_count ?? 0, p.real_job_count ?? 0, p.suspected_count ?? 0,
      JSON.stringify(p.companies ?? {}), JSON.stringify(p.role_families ?? {}),
      JSON.stringify(p.role_samples ?? []), JSON.stringify(p.cities ?? {}),
      p.first_seen ?? null, p.last_seen ?? null, computedAt,
    );
    n += 1;
  }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  console.error(`[profiles] 导入失败：${e?.message || e}`);
  process.exit(1);
}
db.close();

const active = entries.filter(([, p]) => (p.real_job_count ?? 0) >= 3).length;
console.log(JSON.stringify({
  ok: true, imported: n, active_profiles: active,
  chat_count_declared: payload.chat_count, computed_at: computedAt,
}));
