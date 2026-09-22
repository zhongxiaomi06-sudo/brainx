import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildRetentionPlan } from '../src/retention-dry-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = Object.freeze({
  contract_version: 'retention-policy-v1',
  as_of: '2026-09-23T00:00:00.000Z',
  categories: {
    recommendation_snapshots: { ttl_days: 30, keep_latest_runs_per_consultant: 2 },
    throttled_runs: { ttl_days: 7 },
  },
});

function createFixture(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE decision_runs (
      run_id TEXT PRIMARY KEY, consultant_id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE recommendations (
      decision_id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT,
      feature_snapshot_json TEXT);
    CREATE TABLE recommendation_impressions (
      impression_id TEXT PRIMARY KEY, decision_id TEXT, served_at TEXT);
    CREATE TABLE job_outcomes (id INTEGER PRIMARY KEY, decision_id TEXT);
    CREATE TABLE decision_events (id INTEGER PRIMARY KEY, decision_id TEXT);
    CREATE TABLE recommendation_feedback_events (
      event_id TEXT PRIMARY KEY, decision_id TEXT);
  `);
  const addRun = db.prepare('INSERT INTO decision_runs VALUES (?,?,?,?)');
  const addRec = db.prepare('INSERT INTO recommendations VALUES (?,?,?,?)');
  for (let index = 1; index <= 8; index += 1) {
    const run = `run-a-${index}`;
    const decision = `decision-a-${index}`;
    addRun.run(run, 'consultant-a', 'COMPLETED', `2026-07-${String(index).padStart(2, '0')}T00:00:00Z`);
    addRec.run(decision, run, `2026-07-${String(index).padStart(2, '0')}T00:01:00Z`, '{}');
  }
  for (let index = 1; index <= 3; index += 1) {
    const run = `run-b-${index}`;
    addRun.run(run, 'consultant-b', 'COMPLETED', `2026-09-${String(19 + index).padStart(2, '0')}T00:00:00Z`);
    addRec.run(`decision-b-${index}`, run, `2026-09-${String(19 + index).padStart(2, '0')}T00:01:00Z`, '{}');
  }
  db.exec(`
    INSERT INTO recommendation_impressions VALUES
      ('impression-unserved','decision-a-2',NULL),
      ('impression-served','decision-a-3','2026-07-03T01:00:00Z');
    INSERT INTO job_outcomes VALUES (1,'decision-a-4');
    INSERT INTO decision_events VALUES (1,'decision-a-5');
    INSERT INTO recommendation_feedback_events VALUES ('feedback-a-6','decision-a-6');
    INSERT INTO decision_runs VALUES
      ('skip-candidate','consultant-a','SKIPPED_THROTTLED','2026-07-01T00:00:00Z'),
      ('skip-with-rec','consultant-a','SKIPPED_UNCHANGED','2026-07-02T00:00:00Z'),
      ('skip-recent','consultant-a','SKIPPED_THROTTLED','2026-09-22T00:00:00Z');
    INSERT INTO recommendations VALUES
      ('decision-skip','skip-with-rec','2026-07-02T00:01:00Z','{}');
  `);
  return db;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('显式策略仅返回聚合候选，并完整保护最近轮次和五类引用', () => {
  const db = createFixture();
  const report = buildRetentionPlan(db, POLICY);
  assert.equal(report.contract_version, 'retention-plan-v1');
  assert.equal(report.as_of, POLICY.as_of);
  assert.equal(report.read_only, true);
  assert.equal(report.identifiers_emitted, false);
  assert.equal(report.execution_supported, false);
  assert.equal(report.execution_ready, false);
  assert.deepEqual(report.categories.recommendation_snapshots, {
    status: 'READY',
    total: 12,
    eligible_by_age: 8,
    protected: {
      recent_runs: 2,
      impressions: 2,
      served_impressions: 1,
      business_outcomes: 1,
      decision_events: 1,
      feedback_events: 1,
    },
    candidate_count: 1,
  });
  assert.deepEqual(report.categories.throttled_runs, {
    status: 'READY', total: 3, eligible_by_age: 2,
    protected: { has_recommendations: 1 }, candidate_count: 1,
  });
  for (const name of ['ttc_field_reports', 'sync_runs', 'raw_contexts']) {
    assert.deepEqual(report.categories[name], {
      status: 'BLOCKED_POLICY_NOT_IMPLEMENTED', candidate_count: null,
    });
  }
  const text = JSON.stringify(report);
  for (const secret of ['consultant-a', 'decision-a', 'run-a', 'skip-candidate']) {
    assert.equal(text.includes(secret), false);
  }
  db.close();
});

test('缺少冻结特征或反馈引用能力时推荐类别失败关闭', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE decision_runs (
      run_id TEXT PRIMARY KEY, consultant_id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE recommendations (
      decision_id TEXT PRIMARY KEY, run_id TEXT, created_at TEXT);
    CREATE TABLE recommendation_impressions (decision_id TEXT, served_at TEXT);
    CREATE TABLE job_outcomes (decision_id TEXT);
    CREATE TABLE decision_events (decision_id TEXT);
  `);
  const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const report = buildRetentionPlan(db, POLICY);
  const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  assert.deepEqual(after, before);
  assert.deepEqual(report.categories.recommendation_snapshots, {
    status: 'BLOCKED_SCHEMA_CAPABILITY', total: null, eligible_by_age: null,
    protected: null, candidate_count: null,
  });
  db.close();
});

test('新 dry-run CLI 只读打开数据库，重复结果一致且不泄露标识', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-retention-plan-'));
  const dbPath = join(dir, 'fixture.db');
  const policyPath = join(dir, 'policy.json');
  createFixture(dbPath).close();
  writeFileSync(policyPath, JSON.stringify(POLICY));
  const before = digest(dbPath);
  const run = () => spawnSync(process.execPath, [
    'bin/brainx-retention-dry-run.mjs', '--db', dbPath, '--policy', policyPath,
  ], { cwd: ROOT, encoding: 'utf8' });
  const first = run();
  const second = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), JSON.parse(first.stdout));
  assert.equal(digest(dbPath), before);
  assert.equal(first.stdout.includes('decision-a'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('旧 apply 在打开数据库前稳定失败，旧 dry-run 转为只读盘点', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-retention-legacy-'));
  const missingPath = join(dir, 'must-not-exist.db');
  const rejected = spawnSync(process.execPath, [
    'bin/brainx-retention.mjs', '--apply', '--db', missingPath,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /RETENTION_APPLY_DISABLED/);
  assert.equal(existsSync(missingPath), false, '拒绝 apply 前不得创建或打开数据库');

  const dbPath = join(dir, 'fixture.db');
  createFixture(dbPath).close();
  const before = digest(dbPath);
  const audit = spawnSync(process.execPath, [
    'bin/brainx-retention.mjs', '--db', dbPath,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).contract_version, 'retention-inventory-v1');
  assert.equal(digest(dbPath), before);
  rmSync(dir, { recursive: true, force: true });
});
