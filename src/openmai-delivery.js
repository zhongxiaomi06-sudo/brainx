/** OpenMai 最新结果 → 原飞书项目群；持久队列、脱敏卡片、有限重试。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { assessOpenmaiCandidateBatch, extractOpenmaiCandidates } from './openmai-result.js';
import { emitEvent } from './hub/emit.js';
import { buildOpenmaiDeliveryCard } from './sourcing-result-card.js';
export { buildOpenmaiDeliveryCard, groupSafeOpenmaiText, screenCandidateAction,
  addToReloopAction } from './sourcing-result-card.js';

const MAX_RESUME_BYTES = 12 * 1024 * 1024;
// H-2 复用判定共用：search_status='RUNNING' 只有在最近一小时内才算「进行中」，
// 超龄视为中断残留，不再短路 preflight/群按钮（与 failStaleOpenmaiTasks 同一阈值）。
export const STALE_SEARCH_MS = 60 * 60 * 1000;

export { assessOpenmaiCandidateBatch, extractOpenmaiCandidates } from './openmai-result.js';

function trustedResumeHosts(value = process.env.BRAINX_RESUME_DOWNLOAD_HOSTS) {
  return new Set(String(value || 'api.ttcadvisory.com,gateway.ttcadvisory.com,app.ttcadvisory.com')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
}

export async function downloadResumePdf(url, jwt, options = {}) {
  let target;
  try { target = new URL(url); } catch { throw new Error('RESUME_URL_INVALID'); }
  if (target.protocol !== 'https:' || !trustedResumeHosts(options.allowedHosts).has(target.hostname.toLowerCase())) {
    throw new Error('RESUME_URL_NOT_TRUSTED');
  }
  const response = await (options.fetchImpl || globalThis.fetch)(target, {
    headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/pdf' },
    signal: AbortSignal.timeout(options.timeoutMs || 30_000), redirect: 'error',
  });
  const announced = Number(response.headers?.get?.('content-length') || 0);
  if (response.ok === false) throw new Error('RESUME_DOWNLOAD_FAILED');
  if (announced > MAX_RESUME_BYTES) throw new Error('RESUME_PDF_TOO_LARGE');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESUME_BYTES) throw new Error('RESUME_PDF_TOO_LARGE');
  if (bytes.length === 0
      || !bytes.subarray(0, Math.min(1024, bytes.length)).includes(Buffer.from('%PDF-'))) {
    throw new Error('RESUME_PDF_INVALID');
  }
  return bytes;
}

export function enqueueOpenmaiDeliveries(db, at = now()) {
  // 幂等用 LEFT JOIN 反连接表达（已入台的 task_id+chat_id 不再选出），剩余行用普通
  // INSERT——CHECK/外键违例必须抛错暴露。0041 时代用 INSERT OR IGNORE，把 needs_input
  // 的 CHECK 冲突静默吞掉，「请补充职位信息」卡永远到不了群（2026-10-09 审计实证，
  // 0060 已放宽 CHECK）。
  const rows = db.prepare(`SELECT r.task_id, r.consultant_id,
      COALESCE(st.project_id,r.project_id) project_id, r.status, r.result_text,
      l.launch_id, l.chat_id
    FROM openmai_results r
    LEFT JOIN sourcing_tasks st ON st.task_id=r.task_id AND st.provider='supermai'
    JOIN project_launches l
      ON l.launch_id=(SELECT pl.launch_id FROM project_launches pl
        WHERE pl.project_id=COALESCE(st.project_id,r.project_id)
        ORDER BY CASE pl.status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
          WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, pl.created_at, pl.launch_id LIMIT 1)
    LEFT JOIN openmai_deliveries d ON d.task_id=r.task_id AND d.chat_id=l.chat_id
    WHERE l.status='READY' AND l.chat_id IS NOT NULL AND r.task_id IS NOT NULL
      AND r.status IN ('done','needs_input','failed') AND d.delivery_id IS NULL`).all();
  const insert = db.prepare(`INSERT INTO openmai_deliveries
    (delivery_id, task_id, consultant_id, project_id, chat_id, result_status,
     delivery_status, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`);
  let created = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const inserted = insert.run(randomUUID(), row.task_id, row.consultant_id, row.project_id,
        row.chat_id, row.status, at, at, at).changes;
      created += inserted;
      if (inserted) db.prepare(`UPDATE project_launches SET search_status=?,
        search_task_id=?,error_code=?,error_message=?,updated_at=?
        WHERE launch_id=?`).run(
        row.status === 'failed' ? 'FAILED' : 'RUNNING', row.task_id,
        row.status === 'failed' ? 'OPENMAI_SEARCH_FAILED' : null,
        row.status === 'failed' ? 'OpenMai 搜索失败，详细原因将投递到项目群。' : null,
        at, row.launch_id,
      );
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return created;
}

function finishProjectDelivery(db, row, at) {
  const quality = ['done', 'needs_input'].includes(row.result_status)
    ? assessOpenmaiCandidateBatch(row.result_text) : null;
  const incomplete = quality && !quality.complete;
  const failed = row.result_status === 'failed';
  db.prepare(`UPDATE project_launches SET search_status=?, search_task_id=?, error_code=?,
    error_message=?, updated_at=? WHERE launch_id=(SELECT launch_id FROM project_launches
      WHERE project_id=? ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
        WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, created_at, launch_id LIMIT 1)`).run(
    failed || incomplete ? 'FAILED' : 'DONE', row.task_id,
    failed ? 'OPENMAI_SEARCH_FAILED' : quality?.needsInput ? 'OPENMAI_SEARCH_BRIEF_REQUIRED'
      : incomplete ? 'OPENMAI_CANDIDATES_INCOMPLETE' : null,
    failed ? String(row.error || 'OpenMai 搜索失败').slice(0, 240)
      : incomplete ? quality.message : null,
    at, row.project_id,
  );
}

export function retryOpenmaiDelivery(db, consultantId, projectId, at = now()) {
  const row = db.prepare(`SELECT delivery_id,task_id FROM openmai_deliveries
    WHERE consultant_id=? AND project_id=? AND delivery_status='FAILED' AND attempts>=5
    ORDER BY created_at DESC LIMIT 1`).get(consultantId, projectId);
  if (!row) return null;
  db.prepare(`UPDATE openmai_deliveries SET delivery_status='PENDING',attempts=0,last_error=NULL,
    next_attempt_at=?,updated_at=? WHERE delivery_id=?`).run(at, at, row.delivery_id);
  return { status: 'delivery_retry', task_id: row.task_id, started_at: at };
}

export function failStaleOpenmaiTasks(db, at = now(), maxAgeMs = STALE_SEARCH_MS) {
  const cutoff = new Date(Date.parse(at) - maxAgeMs).toISOString();
  const rows = db.prepare(`SELECT project_id,consultant_id,task_id FROM openmai_results
    WHERE status='running' AND started_at<=?`).all(cutoff);
  const update = db.prepare(`UPDATE openmai_results SET status='failed',
    error='OpenMai 任务因服务中断或超时未完成；为避免重复费用，请由顾问明确重试。',finished_at=?
    WHERE project_id=? AND consultant_id=? AND task_id=? AND status='running'`);
  let recovered = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const changed = update.run(at, row.project_id,
        row.consultant_id, row.task_id).changes;
      recovered += changed;
      // specs/019 US1：中断回收也是终态失败，留痕供反馈环统计（渠道按任务号前缀识别）
      if (changed) {
        emitEvent(db, {
          event_type: 'sourcing.search_finished',
          idem_key: `sourcing.finished:${row.project_id}:${row.task_id}`,
          actor: 'system:worker',
          payload: {
            project_id: row.project_id,
            channel: String(row.task_id).startsWith('sm_') ? 'supermai' : 'openmai',
            round: null, status: 'error', result_count: 0,
          },
          evidence_refs: [{ table: 'openmai_results', id: `${row.project_id}|${row.consultant_id}` }],
        });
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return recovered;
}

// H-2：SENDING 无租约兜底——投递是「先置 SENDING 再 await 网络」，进程若在中间崩溃，
// 该行既不在 PENDING/FAILED 的捞取范围、也不满足人工重试（要求 FAILED），将永久卡死，
// 连带 project_launches.search_status 锁在 RUNNING、复用判定短路（只剩 continue_search 逃生门）。
// 处理：SENDING 停留超过 SENDING_STALE_MS（一次飞书 HTTP 调用远用不了这么久）视为进程中断，
// attempts<5 回置 PENDING 由主循环重投；attempts 已耗尽的直接 FAILED 并同步项目状态。
const SENDING_STALE_MS = 10 * 60 * 1000;

export function recoverStaleSendingDeliveries(db, at = now(), staleMs = SENDING_STALE_MS) {
  const cutoff = new Date(Date.parse(at) - staleMs).toISOString();
  const rows = db.prepare(`SELECT delivery_id,project_id,attempts FROM openmai_deliveries
    WHERE delivery_status='SENDING' AND updated_at<=?`).all(cutoff);
  if (!rows.length) return { recovered: 0, exhausted: 0 };
  const reopen = db.prepare(`UPDATE openmai_deliveries SET delivery_status='PENDING',
    next_attempt_at=?,updated_at=? WHERE delivery_id=?`);
  const exhaust = db.prepare(`UPDATE openmai_deliveries SET delivery_status='FAILED',
    last_error='投递中断后长时间未恢复（SENDING 超时），已耗尽重试次数。',updated_at=?
    WHERE delivery_id=?`);
  const failProject = db.prepare(`UPDATE project_launches SET search_status='FAILED',
    error_code='FEISHU_OPENMAI_DELIVERY_FAILED',
    error_message='候选结果已生成，但投递中断且重试耗尽，未能送达飞书项目群；请明确重试投递。',updated_at=?
    WHERE launch_id=(SELECT launch_id FROM project_launches WHERE project_id=?
      ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
        WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, created_at, launch_id LIMIT 1)`);
  let recovered = 0;
  let exhausted = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      if (row.attempts < 5) {
        reopen.run(at, at, row.delivery_id);
        recovered += 1;
      } else {
        exhaust.run(at, row.delivery_id);
        failProject.run(at, row.project_id);
        exhausted += 1;
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { recovered, exhausted };
}

function retryAt(at, attempts) {
  const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, attempts - 1)));
  return new Date(Date.parse(at) + delaySeconds * 1000).toISOString();
}

export async function deliverOpenmaiResultsOnce(db, dependencies = {}) {
  const at = dependencies.at || now();
  failStaleOpenmaiTasks(db, at, dependencies.staleSearchMs || STALE_SEARCH_MS);
  recoverStaleSendingDeliveries(db, at, dependencies.staleSendingMs || SENDING_STALE_MS);
  const enqueued = enqueueOpenmaiDeliveries(db, at);
  const rows = db.prepare(`SELECT d.*, r.result_text, r.error, r.search_round,
      r.search_brief, r.excluded_candidate_refs_json, j.company, j.role
    FROM openmai_deliveries d
    JOIN openmai_results r ON r.task_id=d.task_id AND r.consultant_id=d.consultant_id
    JOIN job_facts j ON j.project_id=d.project_id
    WHERE d.delivery_status IN ('PENDING','FAILED') AND d.attempts < 5 AND d.next_attempt_at <= ?
    ORDER BY d.created_at LIMIT 10`).all(at);
  const send = dependencies.sendInteractiveCard || sendInteractiveCard;
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    db.prepare(`UPDATE openmai_deliveries SET delivery_status='SENDING', attempts=attempts+1,
      updated_at=? WHERE delivery_id=?`).run(at, row.delivery_id);
    try {
      const output = await send({
        target: row.chat_id,
        card: buildOpenmaiDeliveryCard({ job: row, status: row.result_status,
          resultText: row.result_text, error: row.error, publicBaseUrl: dependencies.publicBaseUrl,
          source: String(row.task_id || '').startsWith('sm_') ? 'supermai' : 'openmai' }),
        idempotencyKey: row.delivery_id,
      });
      db.prepare(`UPDATE openmai_deliveries SET delivery_status='SENT', message_id=?, last_error=NULL,
        sent_at=?, updated_at=? WHERE delivery_id=?`).run(output.message_id || null, at, at, row.delivery_id);
      finishProjectDelivery(db, row, at);
      sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      db.prepare(`UPDATE openmai_deliveries SET delivery_status='FAILED', next_attempt_at=?,
        last_error=?, updated_at=? WHERE delivery_id=?`).run(
        retryAt(at, attempts), String(error?.message || error).slice(0, 240), at, row.delivery_id,
      );
      if (attempts >= 5) db.prepare(`UPDATE project_launches SET search_status='FAILED',
        error_code='FEISHU_OPENMAI_DELIVERY_FAILED',
        error_message='候选结果已生成，但连续 5 次未能送达飞书项目群；请明确重试投递。',updated_at=?
        WHERE launch_id=(SELECT launch_id FROM project_launches WHERE project_id=?
          ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
            WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, created_at, launch_id LIMIT 1)`).run(at, row.project_id);
      failed += 1;
    }
  }
  return { enqueued, attempted: rows.length, sent, failed };
}

export function startOpenmaiDeliveryWorker(db, dependencies = {}) {
  const intervalMs = Number(dependencies.intervalMs || process.env.BRAINX_OPENMAI_DELIVERY_INTERVAL_MS || 5000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await deliverOpenmaiResultsOnce(db, dependencies); }
    catch (error) { console.error(`[worker] OpenMai 群投递异常: ${String(error?.message || error).slice(0, 120)}`); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  void tick();
  return { stop: () => clearInterval(timer), tick };
}
