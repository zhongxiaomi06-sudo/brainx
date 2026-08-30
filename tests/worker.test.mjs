/** worker.test.mjs — 独立 worker 进程保活回归（2026-08-30 生产事故）。
 *
 * 事故：bridge/scheduler 的定时器全部 unref（嵌入模式下不挡 API 优雅停机，属正确），
 * 但独立模式（node src/worker.js）事件循环没有任何 ref'd handle，启动打印完三行日志
 * 即 exit 0；systemd Restart=always 每 10s 空转重启（生产实测 NRestarts 50+），
 * bridge 同步/自动推荐/定时推送实际全停。修复：worker.js 主块加保活定时器。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('独立 worker 进程启动后保持存活，SIGTERM 干净退出', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-worker-'));
  const child = spawn(process.execPath, ['src/worker.js'], {
    env: {
      ...process.env,
      BRAINX_DB: join(dir, 'test.db'),
      BRAINX_ENV_FILE: join(dir, '.env.missing'), // 不加载仓库 .env，隔离外部副作用
      BRAINX_BRIDGE_OFF: '1',                      // 关掉桥接（网络），只验保活机理
    },
    stdio: 'ignore',
  });
  // 事故表现：2s 内进程以 code 0 退出（事件循环无 ref'd handle）。保活后必须仍存活。
  await new Promise((r) => setTimeout(r, 2000));
  assert.equal(child.exitCode, null, 'worker 应保持存活（2s 内退出 = 保活失效回归）');
  child.kill('SIGTERM');
  const code = await new Promise((r) => child.once('exit', (c) => r(c)));
  assert.equal(code, 0, 'SIGTERM 应干净退出（exit 0）');
});
