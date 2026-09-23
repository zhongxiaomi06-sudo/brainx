/** oss-sync.test.mjs — brainx-oss-sync 出机同步纪律（specs/021-data-governance US1 延伸）。
 *
 * 覆盖：oss:// 目标解析、幂等计划（同名同大小跳过）、本地快照清单只认命名规范文件、
 *       quick_check 门禁（坏库拒出机）、锁互斥（75）。纯本地零网络，不测 CLI 交互面。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  acquireLock, listLocalSnapshots, ossKey, parseOssTarget, planSync, quickCheckOk,
  LockHeldError, LOCK_EXIT_CODE,
} from '../bin/brainx-oss-sync.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'brainx-oss-sync.mjs');

test('parseOssTarget：解析 bucket/prefix、去尾斜杠、拒绝非法输入', () => {
  assert.deepEqual(parseOssTarget('oss://bk'), { bucket: 'bk', prefix: '' });
  assert.deepEqual(parseOssTarget('oss://bk/brainx/'), { bucket: 'bk', prefix: 'brainx' });
  assert.deepEqual(parseOssTarget('oss://bk/a/b/'), { bucket: 'bk', prefix: 'a/b' });
  assert.throws(() => parseOssTarget(''), /oss:\/\//);
  assert.throws(() => parseOssTarget('oss:///'), /bucket/);
  assert.throws(() => parseOssTarget('https://bk'), /oss:\/\//);
});

test('planSync：远端同名且同大小跳过，否则上传；远端缺失视为上传', () => {
  const local = [
    { name: 'a.db', path: '/x/a.db', size: 100 },
    { name: 'b.db', path: '/x/b.db', size: 200 },
    { name: 'c.db', path: '/x/c.db', size: 300 },
  ];
  const remote = new Map([['a.db', 100], ['b.db', 999]]);
  const { uploads, skips } = planSync(local, remote);
  assert.deepEqual(uploads.map((f) => f.name), ['b.db', 'c.db']);
  assert.deepEqual(skips.map((f) => f.name), ['a.db']);
});

test('listLocalSnapshots：只收命名规范快照，按文件名排序，忽略子目录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oss-sync-test-'));
  try {
    writeFileSync(join(dir, 'brainx-20260923-150346.db'), 'x');
    writeFileSync(join(dir, 'brainx-20260922-150346.db'), 'y');
    writeFileSync(join(dir, 'brainx-junk.db'), 'z');       // 命名不规范，忽略
    writeFileSync(join(dir, 'README.md'), 'r');             // 非快照，忽略
    mkdirSync(join(dir, 'brainx-20260921-000000.db'));      // 目录同名，忽略
    const list = listLocalSnapshots(dir);
    assert.deepEqual(list.map((f) => f.name),
      ['brainx-20260922-150346.db', 'brainx-20260923-150346.db']);
    assert.equal(list[0].size, 1);
  } finally {
    rmSyncFix(dir);
  }
});

test('quickCheckOk：合法 SQLite 通过，损坏文件拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oss-sync-test-'));
  try {
    const good = join(dir, 'good.db');
    const db = new DatabaseSync(good);
    db.exec('CREATE TABLE t (a)');
    db.close();
    assert.equal(quickCheckOk(good), true);

    const bad = join(dir, 'bad.db');
    writeFileSync(bad, 'not a sqlite file at all........');
    assert.equal(quickCheckOk(bad), false);
  } finally {
    rmSyncFix(dir);
  }
});

test('acquireLock：互斥持有，二次获取抛 LockHeldError，释放后可再取', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oss-sync-test-'));
  try {
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), LockHeldError);
    release();
    const release2 = acquireLock(dir);
    release2();
  } finally {
    rmSyncFix(dir);
  }
});

test('CLI 入口：缺 BRAINX_OSS_BUCKET 报错退出 1（不触碰网络）', () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8',
    env: { ...process.env, BRAINX_BACKUP_DIR: join(tmpdir(), 'oss-sync-noop'),
           BRAINX_OSS_BUCKET: '' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /BRAINX_OSS_BUCKET/);
});

test('CLI 入口：锁被占时退出码 75', () => {
  const dir = mkdtempSync(join(tmpdir(), 'oss-sync-test-'));
  try {
    writeFileSync(join(dir, '.oss-sync.lock'), 'held');
    const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8',
      env: { ...process.env, BRAINX_BACKUP_DIR: dir,
             BRAINX_OSS_BUCKET: 'oss://bucket' } });
    assert.equal(r.status, LOCK_EXIT_CODE);
    assert.match(r.stderr, /另一 OSS 同步实例/);
  } finally {
    rmSyncFix(dir);
  }
});

function rmSyncFix(dir) {
  // rmSync 按需引入避免顶层污染；测试目录一律自清理
  import('node:fs').then(({ rmSync }) => rmSync(dir, { recursive: true, force: true }));
}
