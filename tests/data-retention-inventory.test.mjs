import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { buildRetentionInventory } from '../src/data-retention-inventory.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sync_runs (
      sync_id TEXT PRIMARY KEY, errors TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE ttc_field_reports (
      sync_id TEXT PRIMARY KEY, consultant_id TEXT, schema_version TEXT,
      report_json TEXT, created_at TEXT);
    CREATE TABLE job_facts (
      project_id TEXT PRIMARY KEY, sync_id TEXT, raw_json TEXT, updated_at TEXT);
    CREATE TABLE decision_runs (
      run_id TEXT PRIMARY KEY, snapshot_id TEXT, status TEXT, created_at TEXT);
    CREATE TABLE recommendations (
      decision_id TEXT PRIMARY KEY, run_id TEXT, reasons_json TEXT, risks_json TEXT,
      evidence_refs_json TEXT, breakdown_json TEXT, feature_snapshot_json TEXT, created_at TEXT);
    CREATE TABLE recommendation_impressions (
      impression_id TEXT PRIMARY KEY, decision_id TEXT, served_at TEXT, created_at TEXT);
    CREATE TABLE job_outcomes (id INTEGER PRIMARY KEY, decision_id TEXT, observed_at TEXT);
    CREATE TABLE decision_events (
      id INTEGER PRIMARY KEY, decision_id TEXT, payload_json TEXT, occurred_at TEXT);
    CREATE TABLE recommendation_feedback_events (
      event_id TEXT PRIMARY KEY, decision_id TEXT, received_at TEXT);
    CREATE TABLE lark_messages (
      message_id TEXT PRIMARY KEY, text TEXT, mentions_json TEXT, received_at TEXT);
    CREATE TABLE job_facts_drafts (
      draft_id TEXT PRIMARY KEY, raw_json TEXT, company_evidence TEXT,
      role_evidence TEXT, extracted_at TEXT);
  `);
  db.exec(`
    INSERT INTO sync_runs VALUES
      ('sync-secret-a','[]','2026-09-20T00:00:00Z','2026-09-20T00:01:00Z'),
      ('sync-secret-b','["rate limit"]','2026-09-21T00:00:00Z',NULL);
    INSERT INTO ttc_field_reports VALUES
      ('sync-secret-a','consultant-secret','v1','SECRET_FIELD_REPORT','2026-09-20T00:01:00Z');
    INSERT INTO job_facts VALUES
      ('project-secret','sync-secret-a','SECRET_JOB_RAW','2026-09-20T00:02:00Z');
    INSERT INTO decision_runs VALUES
      ('run-secret-a','sync-secret-a','COMPLETED','2026-09-20T00:03:00Z'),
      ('run-secret-skip','sync-secret-a','SKIPPED_THROTTLED','2026-09-21T00:03:00Z');
    INSERT INTO recommendations VALUES
      ('decision-secret','run-secret-a','["reason"]','["risk"]','["evidence"]','[]',
       'SECRET_FEATURE_SNAPSHOT','2026-09-20T00:04:00Z');
    INSERT INTO recommendation_impressions VALUES
      ('impression-secret','decision-secret','2026-09-20T00:05:00Z','2026-09-20T00:04:00Z');
    INSERT INTO job_outcomes VALUES (1,'decision-secret','2026-09-21T00:00:00Z');
    INSERT INTO decision_events VALUES
      (1,'decision-secret','SECRET_EVENT_PAYLOAD','2026-09-21T00:00:00Z');
    INSERT INTO recommendation_feedback_events VALUES
      ('feedback-secret','decision-secret','2026-09-21T00:00:00Z');
    INSERT INTO lark_messages VALUES
      ('message-secret','SECRET_RAW_MESSAGE','["open-id-secret"]','2026-09-21T00:00:00Z');
    INSERT INTO job_facts_drafts VALUES
      ('draft-secret','SECRET_DRAFT_RAW','SECRET_COMPANY_EVIDENCE','SECRET_ROLE_EVIDENCE',
       '2026-09-21T00:00:00Z');
  `);
  return db;
}

test('盘点只返回容量、增长和引用，不返回原文或业务标识', () => {
  const db = fixture();
  const report = buildRetentionInventory(db, { generatedAt: '2026-09-22T00:00:00Z' });
  assert.equal(report.contract_version, 'retention-inventory-v1');
  assert.equal(report.read_only, true);
  assert.equal(report.categories.ttc_field_reports.summary.rows, 1);
  assert.equal(report.categories.sync_runs.references.current_job_facts, 1);
  assert.equal(report.categories.sync_runs.references.decision_run_snapshots, 2);
  assert.equal(report.categories.throttled_runs.summary.rows, 1);
  assert.equal(report.categories.throttled_runs.references.unexpected_recommendations, 0);
  assert.deepEqual(report.categories.recommendation_snapshots.references, {
    impressions: 1, served_impressions: 1, business_outcomes: 1,
    decision_events: 1, feedback_events: 1,
  });
  assert.deepEqual(report.categories.recommendation_snapshots.capabilities, {
    feature_snapshot_column: true, feedback_events_table: true,
  });
  assert.ok(report.categories.recommendation_snapshots.summary.payload_bytes > 0);
  assert.equal(report.categories.raw_contexts.tables.length, 3);
  assert.ok(Object.values(report.categories).every((category) => !category.deletion_ready));
  const text = JSON.stringify(report);
  for (const secret of ['SECRET_', 'sync-secret', 'project-secret', 'decision-secret',
    'consultant-secret', 'open-id-secret']) assert.equal(text.includes(secret), false);
  db.close();
});

test('旧库缺表时标记不可用，盘点本身不创建或修改 schema', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sync_runs (sync_id TEXT PRIMARY KEY, started_at TEXT)');
  const before = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const report = buildRetentionInventory(db);
  const after = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  assert.deepEqual(after, before);
  assert.equal(report.categories.sync_runs.summary.available, true);
  assert.equal(report.categories.ttc_field_reports.summary.available, false);
  assert.equal(report.categories.recommendation_snapshots.references.impressions, null);
  assert.equal(report.categories.recommendation_snapshots.capabilities.feature_snapshot_column, false);
  db.close();
});

test('所有类别在责任、TTL 与恢复点未确认时均阻断删除', () => {
  const db = fixture();
  const report = buildRetentionInventory(db);
  for (const category of Object.values(report.categories)) {
    assert.equal(category.owner.assignment_status, 'UNASSIGNED');
    assert.equal(category.retention.ttl_status, 'UNAPPROVED');
    assert.equal(category.recovery.status, 'UNVERIFIED');
    assert.equal(category.deletion_ready, false);
    assert.ok(category.blockers.length >= 3);
  }
  db.close();
});

test('CLI 只读打开文件且拒绝 --apply', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-retention-inventory-'));
  const path = join(dir, 'fixture.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE sync_runs (sync_id TEXT PRIMARY KEY, started_at TEXT)');
  db.close();
  const digest = () => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = digest();
  const run = spawnSync(process.execPath,
    ['bin/brainx-retention-inventory.mjs', '--db', path], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).read_only, true);
  assert.equal(digest(), before);
  const rejected = spawnSync(process.execPath,
    ['bin/brainx-retention-inventory.mjs', '--db', path, '--apply'], { encoding: 'utf8' });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /READ_ONLY_INVENTORY/);
  assert.equal(digest(), before);
  rmSync(dir, { recursive: true, force: true });
});
