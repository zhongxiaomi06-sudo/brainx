#!/usr/bin/env node
/** 读取显式保留策略并以 SQLite 只读连接输出聚合 dry-run。 */
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRetentionPlan } from '../src/retention-dry-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

if (process.argv.includes('--apply')) {
  console.error('[retention-plan] RETENTION_APPLY_DISABLED');
  process.exit(2);
}

const policyPath = argument('policy');
const dbArgument = argument('db');
if (!policyPath) {
  console.error('[retention-plan] RETENTION_POLICY_PATH_MISSING');
  process.exit(2);
}
if (process.argv.includes('--db') && !dbArgument) {
  console.error('[retention-plan] DATABASE_PATH_MISSING');
  process.exit(2);
}

const dbPath = dbArgument || process.env.BRAINX_DB || join(ROOT, 'data', 'brainx.db');
let db;
try {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  db = new DatabaseSync(dbPath, { readOnly: true });
  console.log(JSON.stringify(buildRetentionPlan(db, policy), null, 2));
} catch {
  console.error('[retention-plan] RETENTION_PLAN_FAILED');
  process.exitCode = 1;
} finally {
  db?.close();
}
