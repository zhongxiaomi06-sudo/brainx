/** openclaw-group-retry.js — OpenClaw 群准入补偿（specs/013）。
 *
 * 群已建、卡片已发、但准入写入失败的 launch 会被标记 PENDING；本任务定时重放
 * ensureOpenClawProjectGroup，成功后按需重启 openclaw-brainx（白名单不热生效）。
 * 重启带节流，避免抖动；重试耗尽（默认 12 次）转 FAILED 并告警。
 */
import { spawn } from 'node:child_process';
import { ensureOpenClawProjectGroup } from './openclaw-group-access.js';
import {
  ensureAccessWithStatus, launchSenders, markOpenclawStatus, pendingOpenclawLaunches,
} from './openclaw-group-status.js';

const DEFAULT_INTERVAL_MS = 600_000;
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_RESTART_MIN_INTERVAL_MS = 900_000;

const UNIT = process.env.BRAINX_OPENCLAW_UNIT || 'openclaw-brainx';

function defaultRestartGateway() {
  if (process.env.BRAINX_OPENCLAW_RESTART_ON_ALLOWLIST === '0') return Promise.resolve({ skipped: 'disabled' });
  return new Promise((resolve) => {
    const child = spawn('systemctl', ['restart', UNIT], { stdio: 'ignore' });
    child.on('error', (error) => resolve({ ok: false, error: String(error.message).slice(0, 200) }));
    child.on('close', (code) => resolve({ ok: code === 0, code }));
  });
}

export function startOpenclawGroupRetryWorker(db, options = {}) {
  const intervalMs = Number(process.env.BRAINX_OPENCLAW_RETRY_INTERVAL_MS
    || options.intervalMs || DEFAULT_INTERVAL_MS);
  const maxAttempts = Number(options.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  const minRestartIntervalMs = Number(process.env.BRAINX_OPENCLAW_RESTART_MIN_INTERVAL_MS
    || options.restartMinIntervalMs || DEFAULT_RESTART_MIN_INTERVAL_MS);
  const access = options.ensureGroup || ensureOpenClawProjectGroup;
  const restartGateway = options.restartGateway || defaultRestartGateway;
  let timer = null;
  let starter = null;
  let running = false;
  let lastRestartAt = 0;

  async function sweep() {
    if (running) return;
    running = true;
    try {
      for (const row of pendingOpenclawLaunches(db, options.limit || 5)) {
        const result = await ensureAccessWithStatus(access, row.chat_id, launchSenders(db, row.chat_id));
        if (result.status === 'OK') {
          markOpenclawStatus(db, row.launch_id, { status: 'OK', error: null, bumpAttempts: true });
          if (Date.now() - lastRestartAt >= minRestartIntervalMs) {
            const restarted = await restartGateway();
            lastRestartAt = Date.now();
            console.log(`[openclaw-retry] ${row.project_id} 准入已恢复，gateway 重启 ${JSON.stringify(restarted)}`);
          } else {
            console.log(`[openclaw-retry] ${row.project_id} 准入已恢复，重启节流内跳过`);
          }
          continue;
        }
        const current = db.prepare('SELECT openclaw_attempts FROM project_launches WHERE launch_id=?')
          .get(row.launch_id);
        const next = Number(current?.openclaw_attempts || 0) + 1;
        const exhausted = next >= maxAttempts;
        markOpenclawStatus(db, row.launch_id, {
          status: exhausted ? 'FAILED' : 'PENDING', error: result.error, bumpAttempts: true,
        });
        if (exhausted) console.warn(`[openclaw-retry] ${row.project_id} 准入重试耗尽：${result.error}`);
      }
    } catch (error) {
      console.warn(`[openclaw-retry] 补偿轮次失败：${String(error?.message || error).slice(0, 200)}`);
    } finally { running = false; }
  }

  timer = setInterval(sweep, intervalMs);
  if (options.runImmediately !== false) {
    starter = setTimeout(sweep, options.initialDelayMs ?? 30_000);
  }
  return {
    sweep,
    stop: () => {
      clearInterval(timer); clearTimeout(starter); timer = null; starter = null;
    },
  };
}
