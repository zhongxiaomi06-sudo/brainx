/** openclaw-group-retry.js — OpenClaw 群准入补偿（specs/013）。
 *
 * 群已建、卡片已发、但准入写入失败的 launch 会被标记 PENDING；本任务定时重放
 * ensureOpenClawProjectGroup，成功后按需重启 openclaw-brainx（白名单不热生效）。
 * 重启带节流，避免抖动；重试耗尽（默认 12 次）转 FAILED 并告警。
 *
 * intake 旧群自愈（2026-09-15 两次生产实证）：机器人进旧群的接管流程
 * （group-intake.js intakeNewChat）调 ensureAccessWithStatus 加白，但结果被静默
 * 丢弃——失败无账本、无重放，launch PENDING 补偿又只覆盖 launch 群。实证
 * LD-荆华密算-销售、LD-Unipat-销售 CARD_SENT 多天却不在 groupAllowFrom，
 * 群里 @机器人 被 groupPolicy=allowlist 直接丢弃，绑定完全无响应。且即使加白
 * 成功，配置也可能被其他运维操作回滚。因此对 SEEN/CARD_SENT/BOUND 的 intake
 * 群做周期性全量自愈（SKIPPED 死群不碰）：逐群幂等 ensure，实际补白
 * （added>0）才按既有节流重启一次 gateway；单群失败只计数，不阻断 sweep。
 * 群数量小（当前 ~20），全量扫的 CLI 调用量可接受。
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

/** intake 自愈目标：SEEN/CARD_SENT/BOUND（SKIPPED 死群不碰）。旧库无表时不炸 sweep。 */
function defaultListIntakeChats(db) {
  try {
    return db.prepare(`SELECT chat_id FROM bot_chat_intake
      WHERE status IN ('SEEN','CARD_SENT','BOUND') ORDER BY chat_id`).all()
      .map((row) => row.chat_id);
  } catch { return []; }
}

/** 逐群幂等 ensure（不用 ensureAccessWithStatus——需要读到 added 判断是否真补白）。
 *  单群失败只计数不阻断；返回 { healed, failures }，healed>0 表示白名单实际变更。 */
export async function healIntakeGroups(chatIds, access) {
  let healed = 0;
  let failures = 0;
  for (const chatId of chatIds) {
    try {
      const result = await access(chatId, []);
      if (result?.added === true || Number(result?.added) > 0) healed += 1;
    } catch (error) {
      failures += 1;
      console.warn(`[openclaw-retry] intake 群 ${chatId} 白名单自愈失败：${
        String(error?.message || error?.code || error).slice(0, 200)}`);
    }
  }
  return { healed, failures };
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
        const current = db.prepare('SELECT openclaw_attempts, openclaw_status FROM project_launches WHERE launch_id=?')
          .get(row.launch_id);
        // 已 FAILED 的行继续兜底重试但不再 bump/重复告警（否则 PENDING↔FAILED 空转刷日志）
        if (current?.openclaw_status !== 'FAILED') {
          const next = Number(current?.openclaw_attempts || 0) + 1;
          const exhausted = next >= maxAttempts;
          markOpenclawStatus(db, row.launch_id, {
            status: exhausted ? 'FAILED' : 'PENDING', error: result.error, bumpAttempts: true,
          });
          if (exhausted) console.warn(`[openclaw-retry] ${row.project_id} 准入重试耗尽：${result.error}`);
        }
      }
      // intake 旧群白名单自愈：launch PENDING 重放之后全量扫一轮。
      const listIntake = options.listIntakeChats || (() => defaultListIntakeChats(db));
      const { healed, failures } = await healIntakeGroups(listIntake(), access);
      if (failures) console.warn(`[openclaw-retry] intake 自愈 ${failures} 群失败（下轮继续，不阻断 sweep）`);
      if (healed > 0) {
        if (Date.now() - lastRestartAt >= minRestartIntervalMs) {
          const restarted = await restartGateway();
          lastRestartAt = Date.now();
          console.log(`[openclaw-retry] intake 自愈补白 ${healed} 群，gateway 重启 ${JSON.stringify(restarted)}`);
        } else {
          console.log(`[openclaw-retry] intake 自愈补白 ${healed} 群，重启节流内跳过`);
        }
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
