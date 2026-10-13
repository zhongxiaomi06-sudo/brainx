#!/usr/bin/env node
/** 只读输出数据增长、引用与保留责任盘点；不提供清理模式。 */
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRetentionInventory } from '../src/data-retention-inventory.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbIndex = process.argv.indexOf('--db');

if (process.argv.includes('--apply')) {
  console.error('[retention-inventory] READ_ONLY_INVENTORY');
  process.exit(2);
}
if (dbIndex >= 0 && !process.argv[dbIndex + 1]) {
  console.error('[retention-inventory] DATABASE_PATH_MISSING');
  process.exit(2);
}

const dbPath = dbIndex >= 0 ? process.argv[dbIndex + 1]
  : process.env.BRAINX_DB || join(ROOT, 'data', 'brainx.db');
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  console.log(JSON.stringify(buildRetentionInventory(db), null, 2));
} catch {
  console.error('[retention-inventory] RETENTION_INVENTORY_FAILED');
  process.exitCode = 1;
} finally {
  db?.close();
}
