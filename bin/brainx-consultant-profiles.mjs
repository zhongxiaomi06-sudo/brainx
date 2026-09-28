#!/usr/bin/env node
/** brainx-consultant-profiles — 顾问画像导入（第一版对应，与 client_profiles 对称）。
 * 数据源：consultant-profiles.json（consultant_aggregate.py 聚合产物）。
 * 消费方：routed push（岗位族×顾问方向）、召回权重、负载均衡观察。
 * 用法：node bin/brainx-consultant-profiles.mjs --file data/draft-cleanup/consultant-profiles.json
 */
import '../src/env.js';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { now } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ix = process.argv.indexOf('--file');
const file = ix !== -1 ? process.argv[ix + 1] : join(ROOT, 'data', 'draft-cleanup', 'consultant-profiles.json');

const dbPath = process.env.BRAINX_DB_PATH || join(ROOT, 'data', 'brainx.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`
CREATE TABLE IF NOT EXISTS consultant_profiles (
  consultant_id     TEXT PRIMARY KEY,
  accepted_count    INTEGER NOT NULL DEFAULT 0,
  viewed_count      INTEGER NOT NULL DEFAULT 0,
  active_jobs       INTEGER NOT NULL DEFAULT 0,
  role_families_json TEXT NOT NULL DEFAULT '{}',
  top_family        TEXT,
  companies_json    TEXT NOT NULL DEFAULT '{}',
  computed_at       TEXT NOT NULL
);`);

const payload = JSON.parse(readFileSync(file, 'utf8'));
const entries = Object.entries(payload.consultants || {});
if (!entries.length) { console.error('[cprofiles] 无顾问画像数据'); process.exit(1); }

const computedAt = now();
const upsert = db.prepare(`
  INSERT INTO consultant_profiles
    (consultant_id, accepted_count, viewed_count, active_jobs, role_families_json, top_family, companies_json, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(consultant_id) DO UPDATE SET
    accepted_count=excluded.accepted_count, viewed_count=excluded.viewed_count,
    active_jobs=excluded.active_jobs, role_families_json=excluded.role_families_json,
    top_family=excluded.top_family, companies_json=excluded.companies_json, computed_at=excluded.computed_at`);

db.exec('BEGIN');
try {
  for (const [cid, p] of entries) {
    upsert.run(cid, p.accepted ?? 0, p.viewed ?? 0, p.active_jobs ?? 0,
      JSON.stringify(p.role_families ?? {}), p.top_family ?? null,
      JSON.stringify(p.companies ?? {}), computedAt);
  }
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* ignore */ }
  console.error(`[cprofiles] 导入失败：${e?.message || e}`);
  process.exit(1);
}
db.close();
console.log(JSON.stringify({ ok: true, imported: entries.length, computed_at: computedAt }));
