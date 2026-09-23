#!/usr/bin/env node
/** brainx-oss-sync — 每日快照出机同步到 OSS（specs/021-data-governance US1「本机以外」延伸）。
 *
 * 纪律：
 *  - 默认 dry-run：只产出计划（uploads/skips/failed），不触碰 OSS；--apply 才实传
 *    （与 bin/brainx-ledger-retention.mjs「默认 dry-run」纪律一致）；
 *  - 幂等：远端已有同名且同大小对象 → 跳过；上传完成后重读远端大小复核；
 *  - 只处理 brainx-YYYYMMDD-HHMMSS.db 命名规范的文件，其他文件一律不动；
 *  - 上传前对本地文件做 PRAGMA quick_check，不过关的文件跳过并计入 failed（不传坏文件）；
 *  - 远端永不删除：本地 14 天滚动保留，远端是最后防线，全量留存；
 *    容量与冷热分层交给 OSS 生命周期规则，本脚本不管删；
 *  - 凭据走 ECS 实例 RAM 角色（profile 缺省 ecs-oss），不落 AK；
 *  - ECS 与 bucket 同地域走内网 endpoint（缺省 cn-hangzhou-internal），免公网流量。
 *
 * env：BRAINX_BACKUP_DIR（缺省 data/backups）、BRAINX_OSS_BUCKET（必填，形如 oss://<bucket>[/<prefix>]）、
 *      BRAINX_OSS_PROFILE（缺省 ecs-oss）、BRAINX_OSS_ENDPOINT（缺省内网 endpoint）、
 *      BRAINX_OSS_CLI（缺省 aliyun）。
 * 用法：node bin/brainx-oss-sync.mjs [--apply]
 *   成功/计划：stdout 一行 JSON 摘要；失败：stderr 原因 + 非零退出码（锁占用 = 75，其余 = 1）。
 */
import '../src/env.js';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SNAPSHOT_RE } from './brainx-backup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const LOCK_EXIT_CODE = 75;
export const LOCK_FILE = '.oss-sync.lock';
export const DEFAULT_ENDPOINT = 'https://oss-cn-hangzhou-internal.aliyuncs.com';

export class LockHeldError extends Error {
  constructor(lockPath) {
    super(`另一 OSS 同步实例正在运行（锁文件存在：${lockPath}）`);
    this.code = 'LOCK_HELD';
  }
}

/** 解析 BRAINX_OSS_BUCKET（oss://<bucket>[/<prefix>]），prefix 去尾斜杠。 */
export function parseOssTarget(raw) {
  if (!raw || !raw.startsWith('oss://')) {
    throw new Error('BRAINX_OSS_BUCKET 必须形如 oss://<bucket>[/<prefix>]');
  }
  const rest = raw.slice('oss://'.length);
  const slash = rest.indexOf('/');
  const bucket = slash === -1 ? rest : rest.slice(0, slash);
  const prefix = slash === -1 ? '' : rest.slice(slash + 1).replace(/\/+$/, '');
  if (!bucket) throw new Error('bucket 名不能为空');
  return { bucket, prefix };
}

export function ossKey(prefix, name) {
  return prefix ? `${prefix}/${name}` : name;
}

/** 列出备份目录内命名规范的快照（只看文件，其他文件不动）。 */
export function listLocalSnapshots(backupDir) {
  const out = [];
  for (const name of readdirSync(backupDir)) {
    if (!SNAPSHOT_RE.test(name)) continue;
    const path = join(backupDir, name);
    const st = statSync(path);
    if (!st.isFile()) continue;
    out.push({ name, path, size: st.size });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** 幂等计划：远端同名且同大小 → skip，否则 upload。 */
export function planSync(localList, remoteSizes) {
  const uploads = [];
  const skips = [];
  for (const f of localList) {
    (remoteSizes.get(f.name) === f.size ? skips : uploads).push(f);
  }
  return { uploads, skips };
}

/** 本地快照完整性门禁：quick_check 全 ok 才允许出机。 */
export function quickCheckOk(path) {
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    return db.prepare('PRAGMA quick_check').all().every((r) => r.quick_check === 'ok');
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch { /* 已关闭则忽略 */ }
  }
}

/** O_EXCL 抢锁（与 backup 锁分离，互不阻塞）；成功返回释放函数。 */
export function acquireLock(backupDir) {
  const lockPath = join(backupDir, LOCK_FILE);
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e?.code === 'EEXIST') throw new LockHeldError(lockPath);
    throw e;
  }
  return () => {
    try { closeSync(fd); } catch { /* 已关闭则忽略 */ }
    try { unlinkSync(lockPath); } catch { /* 已被清理则忽略 */ }
  };
}

function runCli(cli, args, { timeout = 300000 } = {}) {
  const r = spawnSync(cli, args, { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || String(r.error || '') };
}

/** 远端对象大小；不存在或查询失败返回 null（404 与凭据失败对调用方都是「无有效远端副本」）。 */
export function ossObjectSize(cli, url, { profile, endpoint }) {
  const args = ['oss', 'stat', url, '--profile', profile];
  if (endpoint) args.push('--endpoint', endpoint);
  const r = runCli(cli, args);
  if (r.status !== 0) return null;
  const m = /Content-Length\s*:\s*(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) : null;
}

/** 执行一轮同步。apply=false 只出计划；成功返回摘要对象，失败抛错。 */
export function runSync({ backupDir, bucketEnv, profile = 'ecs-oss', endpoint = DEFAULT_ENDPOINT,
                          cli = 'aliyun', apply = false }) {
  mkdirSync(backupDir, { recursive: true });
  const release = acquireLock(backupDir);
  try {
    const { bucket, prefix } = parseOssTarget(bucketEnv);
    const localList = listLocalSnapshots(backupDir);

    // 远端现状：逐文件 stat（快照数量级 ≤ 保留窗口天数，开销可控）。
    const remoteSizes = new Map();
    const remoteErrors = [];
    for (const f of localList) {
      const url = `oss://${bucket}/${ossKey(prefix, f.name)}`;
      const size = ossObjectSize(cli, url, { profile, endpoint });
      if (size === null) remoteErrors.push(f.name);
      else remoteSizes.set(f.name, size);
    }

    const { uploads, skips } = planSync(localList, remoteSizes);
    if (!apply) {
      return { ok: true, apply: false, bucket, prefix,
               plan: { uploads: uploads.map((f) => f.name), skipped: skips.length },
               remote_errors: remoteErrors };
    }

    const uploaded = [];
    const failed = [];
    for (const f of uploads) {
      const url = `oss://${bucket}/${ossKey(prefix, f.name)}`;
      if (!quickCheckOk(f.path)) {
        failed.push({ file: f.name, reason: 'quick_check 不过关，拒绝出机' });
        continue;
      }
      const r = runCli(cli, ['oss', 'cp', f.path, url, '-f', '--profile', profile,
                             '--endpoint', endpoint]);
      const remoteSize = r.status === 0 ? ossObjectSize(cli, url, { profile, endpoint }) : null;
      if (remoteSize === f.size) uploaded.push(f.name);
      else failed.push({ file: f.name, reason: r.status !== 0 ? r.stderr.trim().slice(0, 300) : '上传后大小复核不一致' });
    }
    return { ok: failed.length === 0, apply: true, bucket, prefix,
             uploaded, skipped: skips.length, failed };
  } finally {
    release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const backupDir = process.env.BRAINX_BACKUP_DIR || join(ROOT, 'data', 'backups');
  const bucketEnv = process.env.BRAINX_OSS_BUCKET;
  const profile = process.env.BRAINX_OSS_PROFILE || 'ecs-oss';
  const endpoint = process.env.BRAINX_OSS_ENDPOINT || DEFAULT_ENDPOINT;
  const cli = process.env.BRAINX_OSS_CLI || 'aliyun';
  const apply = process.argv.includes('--apply');
  try {
    const summary = runSync({ backupDir, bucketEnv, profile, endpoint, cli, apply });
    console.log(JSON.stringify(summary));
    if (summary.apply && !summary.ok) process.exit(1);
  } catch (e) {
    if (e instanceof LockHeldError) {
      console.error(`[oss-sync] ${e.message}，本次跳过（退出码 ${LOCK_EXIT_CODE}）`);
      process.exit(LOCK_EXIT_CODE);
    }
    console.error(`[oss-sync] 同步失败：${e?.message || e}`);
    process.exit(1);
  }
}
