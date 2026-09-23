/** ledger-retention.test.mjs — brainx-ledger-retention 保留/归档纪律（specs/021 US2，SC-004 零误删）。
 *
 * 合成库（全量真实迁移）覆盖：
 *  1. 超龄未引用行被归档（进归档库）并从主库删除；
 *  2. 窗口内行保留；
 *  3. 引用保护：pending 草稿（message_id/event_id 双向）、consumer_failures 未 resolved、
 *     evidence_refs LIKE 口径（含 LIKE 通配符转义的精确性）；
 *  4. dry-run 对主库零写入、不产生归档/快照文件；
 *  5. --apply 重复执行幂等（第二轮 archive=0，行数稳定），执行前自动留安全快照。
 * 全部跑真实 CLI 子进程，断言落库结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'brainx-ledger-retention.mjs');

const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400e3).toISOString();
const OLD = iso(200);   // 三个窗口（90/90/180）都超龄
const RECENT = iso(1);  // 三个窗口内

/**
 * 造一座覆盖全部保护分支的合成库。
 * 事件：ev-old（超龄无引用→归档）、ev-recent（窗口内→留）、ev-pending-draft（被 pending 草稿引用→留）、
 *       ev-unresolved（被未 resolved 失败引用→留）、ev-resolved（失败已 resolved→归档）、
 *       ev-refs-msg（窗口内，evidence_refs 引用 m-ev-ref → 保护消息）、ev-old-refs（超龄，引用 m-only-old-ref）。
 * 消息：m-old（→归档）、m-recent（留）、m-pending-job / m-pending-judg（pending 草稿保护）、
 *       m-ev-ref（被留存事件 evidence_refs 保护）、m-only-old-ref（只被将归档事件引用→归档）、
 *       omXlookXalike（LIKE 转义精确性：不因 om_look_alike 的保护模式误留→归档）。
 * openmai：om-old（180 天前完成→归档）、om-running（进行中，启动在窗口内→留）。
 */
function makeFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-retention-test-'));
  const dbPath = join(dir, 'brainx.db');
  const db = openDb(dbPath);

  const insEvent = db.prepare(`INSERT INTO workflow_event_log
    (event_id, idem_key, event_type, actor, occurred_at, payload, evidence_refs) VALUES (?,?,?,?,?,?,?)`);
  const ev = (id, occurredAt, refs = []) =>
    insEvent.run(id, `idem:${id}`, 'test.event', 'system:test', occurredAt, '{}', JSON.stringify(refs));
  ev('ev-old', OLD);
  ev('ev-recent', RECENT);
  ev('ev-pending-draft', OLD);
  ev('ev-unresolved', OLD);
  ev('ev-resolved', OLD);
  ev('ev-refs-msg', RECENT, [{ table: 'lark_messages', id: 'm-ev-ref' }]);
  ev('ev-old-refs', OLD, [{ table: 'lark_messages', id: 'm-only-old-ref' }, { table: 'lark_messages', id: 'om_look_alike' }]);

  const insMsg = db.prepare(`INSERT INTO lark_messages
    (message_id, chat_id, message_type, text, create_time, received_at) VALUES (?,?,?,?,?,?)`);
  const msg = (id, createTime) => insMsg.run(id, 'chat-1', 'text', `正文:${id}`, createTime, createTime);
  msg('m-old', OLD);
  msg('m-recent', RECENT);
  msg('m-pending-job', OLD);
  msg('m-pending-judg', OLD);
  msg('m-ev-ref', OLD);
  msg('m-only-old-ref', OLD);
  msg('omXlookXalike', OLD);

  // pending 草稿：job_facts_drafts 引用 ev-pending-draft + m-pending-job
  db.prepare(`INSERT INTO job_facts_drafts (draft_id, event_id, message_id, source, status, raw_json, extracted_at)
    VALUES ('d-job-1', 'ev-pending-draft', 'm-pending-job', 'rules', 'pending', '{}', ?)`).run(RECENT);
  // pending 草稿：judgment_drafts 引用 m-pending-judg（event 用窗口内的 ev-recent，避免改变事件侧断言）
  db.prepare(`INSERT INTO judgment_drafts (draft_id, event_id, message_id, source, status, raw_json, extracted_at)
    VALUES ('d-judg-1', 'ev-recent', 'm-pending-judg', 'rules', 'pending', '{}', ?)`).run(RECENT);
  // confirmed 草稿不构成保护：引用 ev-old，ev-old 仍应被归档
  db.prepare(`INSERT INTO job_facts_drafts (draft_id, event_id, message_id, source, status, raw_json, extracted_at)
    VALUES ('d-job-2', 'ev-old', 'm-old', 'rules', 'confirmed', '{}', ?)`).run(OLD);

  // consumer_failures：未 resolved 保护 ev-unresolved；已 resolved 不保护 ev-resolved
  const insCf = db.prepare(`INSERT INTO consumer_failures
    (event_id, consumer_name, attempts, first_failed_at, last_failed_at, resolved_at) VALUES (?,?,?,?,?,?)`);
  insCf.run('ev-unresolved', 'job-extract', 1, RECENT, RECENT, null);
  insCf.run('ev-resolved', 'job-extract', 3, OLD, OLD, RECENT);

  // openmai_results：180 天窗口
  const insOm = db.prepare(`INSERT INTO openmai_results
    (project_id, consultant_id, status, result_text, started_at, finished_at) VALUES (?,?,?,?,?,?)`);
  insOm.run('p-old', 'c1', 'done', '结果 markdown', OLD, OLD);
  insOm.run('p-running', 'c1', 'running', null, RECENT, null);

  db.close();
  return { dir, dbPath };
}

function runCli(env, args = []) {
  return spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

const count = (dbPath, sql) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const n = db.prepare(sql).get().n;
  db.close();
  return n;
};
const hasRow = (dbPath, sql, ...args) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const row = db.prepare(sql).get(...args);
  db.close();
  return !!row;
};

/** 主库现状断言（dry-run 后与 apply 后复用两套期望值）。 */
function assertMainDb(dbPath, kept) {
  for (const [id, present] of Object.entries(kept.events)) {
    assert.equal(hasRow(dbPath, 'SELECT 1 FROM workflow_event_log WHERE event_id=?', id), present, `event ${id}`);
  }
  for (const [id, present] of Object.entries(kept.msgs)) {
    assert.equal(hasRow(dbPath, 'SELECT 1 FROM lark_messages WHERE message_id=?', id), present, `msg ${id}`);
  }
  for (const [id, present] of Object.entries(kept.openmai)) {
    assert.equal(hasRow(dbPath, 'SELECT 1 FROM openmai_results WHERE project_id=?', id), present, `openmai ${id}`);
  }
}

// 期望：超龄未引用归档；pending/未 resolved/留存事件 evidence_refs 引用的一律保留
const EXPECT_KEPT = {
  events: { 'ev-old': false, 'ev-recent': true, 'ev-pending-draft': true, 'ev-unresolved': true, 'ev-resolved': false, 'ev-refs-msg': true, 'ev-old-refs': false },
  msgs: { 'm-old': false, 'm-recent': true, 'm-pending-job': true, 'm-pending-judg': true, 'm-ev-ref': true, 'm-only-old-ref': false, 'omXlookXalike': false },
  openmai: { 'p-old': false, 'p-running': true },
};
const EXPECT_ALL_KEPT = {
  events: Object.fromEntries(Object.keys(EXPECT_KEPT.events).map((k) => [k, true])),
  msgs: Object.fromEntries(Object.keys(EXPECT_KEPT.msgs).map((k) => [k, true])),
  openmai: Object.fromEntries(Object.keys(EXPECT_KEPT.openmai).map((k) => [k, true])),
};

test('dry-run：输出计数对照，主库零写入，不产生归档库与安全快照', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const backupDir = join(dir, 'backups');
    const archiveDir = join(dir, 'archive');
    const r = runCli({ BRAINX_DB_PATH: dbPath, BRAINX_BACKUP_DIR: backupDir, BRAINX_ARCHIVE_DIR: archiveDir });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /dry-run/);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dry_run, true);
    assert.deepEqual(
      { lark: out.tables.lark_messages.archive, events: out.tables.workflow_event_log.archive, openmai: out.tables.openmai_results.archive },
      { lark: 3, events: 3, openmai: 1 },
    );
    assert.equal(out.tables.lark_messages.scanned, 7);
    assert.equal(out.tables.workflow_event_log.scanned, 7);
    // 零写入证明：所有行仍在，且无归档/备份产物
    assertMainDb(dbPath, EXPECT_ALL_KEPT);
    assert.ok(!existsSync(archiveDir));
    assert.ok(!existsSync(backupDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--apply：先自动安全快照，超龄归档入库并删主库，引用保护全保留', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const backupDir = join(dir, 'backups');
    const archiveDir = join(dir, 'archive');
    const r = runCli({ BRAINX_DB_PATH: dbPath, BRAINX_BACKUP_DIR: backupDir, BRAINX_ARCHIVE_DIR: archiveDir }, ['--apply']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dry_run, false);
    assert.deepEqual(out.archived, { lark_messages: 3, workflow_event_log: 3, openmai_results: 1 });

    // 执行前自动留档：安全快照存在且文件名规范
    assert.ok(existsSync(out.snapshot));
    assert.match(out.snapshot, /brainx-\d{8}-\d{6}\.db$/);
    assert.equal(dirname(out.snapshot), backupDir);

    // 主库：保护行全部保留，超龄行已删
    assertMainDb(dbPath, EXPECT_KEPT);

    // 归档库：结构与源一致（同名表），搬走行的正文可读
    const archiveFiles = readdirSync(archiveDir).filter((f) => f.endsWith('.db'));
    assert.equal(archiveFiles.length, 1);
    assert.match(archiveFiles[0], /^brainx-archive-\d{8}\.db$/);
    const archPath = join(archiveDir, archiveFiles[0]);
    assert.equal(count(archPath, 'SELECT COUNT(*) n FROM lark_messages'), 3);
    assert.equal(count(archPath, 'SELECT COUNT(*) n FROM workflow_event_log'), 3);
    assert.equal(count(archPath, 'SELECT COUNT(*) n FROM openmai_results'), 1);
    assert.ok(hasRow(archPath, `SELECT 1 FROM lark_messages WHERE message_id='m-old' AND text='正文:m-old'`));
    assert.ok(hasRow(archPath, `SELECT 1 FROM openmai_results WHERE project_id='p-old' AND result_text='结果 markdown'`));
    // 归档行带主键约束（重复搬入由 INSERT OR REPLACE 吸收，不翻倍）
    const arch = new DatabaseSync(archPath, { readOnly: true });
    const pk = arch.prepare(`PRAGMA table_info("lark_messages")`).all().filter((c) => c.pk > 0).map((c) => c.name);
    arch.close();
    assert.deepEqual(pk, ['message_id']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('幂等：--apply 连跑两轮，第二轮 archive=0 且主库/归档库行数稳定', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const backupDir = join(dir, 'backups');
    const archiveDir = join(dir, 'archive');
    const env = { BRAINX_DB_PATH: dbPath, BRAINX_BACKUP_DIR: backupDir, BRAINX_ARCHIVE_DIR: archiveDir };
    const r1 = runCli(env, ['--apply']);
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = runCli(env, ['--apply']);
    assert.equal(r2.status, 0, r2.stderr);
    const out2 = JSON.parse(r2.stdout);
    assert.deepEqual(out2.archived, { lark_messages: 0, workflow_event_log: 0, openmai_results: 0 });
    // 主库行数与第一轮后一致
    assertMainDb(dbPath, EXPECT_KEPT);
    // 归档库仍是 3/3/1（没被第二轮翻倍）
    const archPath = join(archiveDir, readdirSync(archiveDir).find((f) => f.endsWith('.db')));
    assert.equal(count(archPath, 'SELECT COUNT(*) n FROM lark_messages'), 3);
    assert.equal(count(archPath, 'SELECT COUNT(*) n FROM workflow_event_log'), 3);
    assert.equal(count(archPath, 'SELECT COUNT(*) n FROM openmai_results'), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('窗口可调：env 把 lark_messages 窗口拉到 400 天后 dry-run archive=0', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const r = runCli({
      BRAINX_DB_PATH: dbPath,
      BRAINX_BACKUP_DIR: join(dir, 'backups'),
      BRAINX_ARCHIVE_DIR: join(dir, 'archive'),
      BRAINX_RETENTION_LARK_MESSAGES_DAYS: '400',
    });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.tables.lark_messages.window_days, 400);
    assert.equal(out.tables.lark_messages.archive, 0);
    assert.equal(out.tables.workflow_event_log.archive, 3); // 其他窗口不受影响
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
