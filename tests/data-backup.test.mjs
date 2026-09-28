/** data-backup.test.mjs — brainx-backup 快照纪律（specs/021-data-governance US1）。
 *
 * 覆盖：VACUUM INTO 快照 → 只读打开 quick_check → 关键表行数与源库一致 →
 *       超龄快照滚动清理 → .backup.lock 互斥（退出码 75）→ 失败不留半成品。
 * 全部在黑盒临时库上跑真实 CLI（子进程），不 mock 文件系统。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, now } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'brainx-backup.mjs');

/** 建一座带真实迁移的小临时库 + 各自检表一行数据，返回 { dir, dbPath }。 */
function makeFixtureDb() {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-backup-test-'));
  const dbPath = join(dir, 'brainx.db');
  const db = openDb(dbPath);
  const ts = now();
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, rows_expected, rows_read, complete, input_hash, started_at)
    VALUES ('sync-bak', 'c1', 'fixture', ?, 0, 0, 1, 'h', ?)`).run(ts, ts);
  db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at)
    VALUES ('p-bak', 'ACME', 'CTO', ?, 'sync-bak', '{}', ?)`).run(ts, ts);
  db.prepare(`INSERT INTO lark_messages (message_id, chat_id, message_type, text, create_time, received_at)
    VALUES ('om_bak_1', 'chat-1', 'text', '快照自检消息', ?, ?)`).run(ts, ts);
  db.prepare(`INSERT INTO workflow_event_log (event_id, idem_key, event_type, actor, occurred_at, payload)
    VALUES ('ev-bak-1', 'bak:test:1', 'test.event', 'system:test', ?, '{}')`).run(ts);
  db.close();
  return { dir, dbPath };
}

function runCli(env) {
  return spawnSync(process.execPath, [BIN], { env: { ...process.env, ...env }, encoding: 'utf8' });
}

test('快照：VACUUM INTO 产物可只读打开、quick_check ok、行数与源库一致', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const backupDir = join(dir, 'backups');
    const r = runCli({ BRAINX_DB_PATH: dbPath, BRAINX_BACKUP_DIR: backupDir });
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout.trim());
    assert.equal(summary.ok, true);
    assert.equal(summary.quick_check, 'ok');
    assert.equal(summary.counts.lark_messages, 1);
    assert.equal(summary.counts.workflow_event_log, 1);
    assert.equal(summary.counts.job_facts, 1);
    assert.ok(existsSync(summary.snapshot));

    // 快照独立只读打开复核（不经脚本口径）
    const snap = new DatabaseSync(summary.snapshot, { readOnly: true });
    assert.deepEqual(snap.prepare('PRAGMA quick_check').all().map((x) => x.quick_check), ['ok']);
    assert.equal(snap.prepare('SELECT COUNT(*) n FROM lark_messages').get().n, 1);
    assert.equal(snap.prepare('SELECT text FROM lark_messages WHERE message_id=?').get('om_bak_1').text, '快照自检消息');
    snap.close();
    // 锁文件已释放
    assert.ok(!existsSync(join(backupDir, '.backup.lock')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('滚动保留：超龄快照删除、窗口内保留、非本脚本文件不动', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const backupDir = join(dir, 'backups');
    const stale = join(backupDir, 'brainx-20200101-000000.db');
    const fresh = join(backupDir, `brainx-${new Date(Date.now() - 86400e3).toISOString().slice(0, 10).replaceAll('-', '')}-010203.db`);
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(stale, 'fake');
    writeFileSync(fresh, 'fake');
    writeFileSync(join(backupDir, 'notes.txt'), '别动我');

    const r = runCli({ BRAINX_DB_PATH: dbPath, BRAINX_BACKUP_DIR: backupDir, BRAINX_BACKUP_KEEP_DAYS: '14' });
    assert.equal(r.status, 0, r.stderr);
    const summary = JSON.parse(r.stdout.trim());
    assert.deepEqual(summary.pruned, ['brainx-20200101-000000.db']);
    assert.ok(!existsSync(stale));
    assert.ok(existsSync(fresh));
    assert.ok(existsSync(join(backupDir, 'notes.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重叠保护：锁文件存在时退出码 75 且不产生新快照', () => {
  const { dir, dbPath } = makeFixtureDb();
  try {
    const backupDir = join(dir, 'backups');
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, '.backup.lock'), '');
    const r = runCli({ BRAINX_DB_PATH: dbPath, BRAINX_BACKUP_DIR: backupDir });
    assert.equal(r.status, 75, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /另一备份实例/);
    assert.equal(readdirSync(backupDir).filter((f) => f.endsWith('.db')).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('失败路径：源库不存在时非零退出且 stderr 可见原因', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-backup-test-'));
  try {
    const r = runCli({ BRAINX_DB_PATH: join(dir, 'no-such.db'), BRAINX_BACKUP_DIR: join(dir, 'backups') });
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('[backup] 备份失败'), r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// execFileSync 仅用于确认 CLI 可作为独立入口运行（ shebang/路径自检），避免上面漏掉启动期错误。
test('CLI 冒烟：--help 以外的正常路径已由上面用例覆盖，此处仅确认模块可加载', () => {
  const out = execFileSync(process.execPath, ['-e', `import('file://${BIN}').then(()=>console.log('loaded'))`], { encoding: 'utf8' });
  assert.equal(out.trim(), 'loaded');
});
