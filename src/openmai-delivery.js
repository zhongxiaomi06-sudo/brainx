/** OpenMai 最新结果 → 原飞书项目群；持久队列、脱敏卡片、有限重试。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function groupSafeOpenmaiText(value, max = 6500) {
  const cleaned = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(PHONE, '[联系方式已隐藏]')
    .replace(EMAIL, '[联系方式已隐藏]')
    .trim();
  if (!cleaned) return 'OpenMai 已完成，但本轮没有返回可展示的候选人内容。';
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n\n*内容较长，完整结果请在工作台查看。*` : cleaned;
}

export function buildOpenmaiDeliveryCard({ job, status, resultText, error, publicBaseUrl }) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const target = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: job.project_id });
  const success = status === 'done';
  const content = success
    ? `**${job.company} · ${job.role}**\n\n${groupSafeOpenmaiText(resultText)}`
    : `**${job.company} · ${job.role}**\n\n本轮候选人搜索失败：${groupSafeOpenmaiText(error, 500)}\n\n请修复连接后在工作台重试。`;
  return {
    config: { wide_screen_mode: true },
    header: { template: success ? 'green' : 'red', title: { tag: 'plain_text',
      content: success ? 'BrainTex · 首轮候选人已就绪' : 'BrainTex · 候选人搜索失败' } },
    elements: [
      { tag: 'markdown', content },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: success ? '查看完整结果并评估' : '打开工作台处理' },
        multi_url: { url: target, pc_url: target, android_url: target, ios_url: target } }] },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: '项目群投递 · 联系方式默认隐藏 · 候选人事实仍需顾问核验' }] },
    ],
  };
}

export function enqueueOpenmaiDeliveries(db, at = now()) {
  const rows = db.prepare(`SELECT r.task_id, r.consultant_id, r.project_id, r.status, l.chat_id
    FROM openmai_results r JOIN project_launches l
      ON l.consultant_id=r.consultant_id AND l.project_id=r.project_id
    WHERE l.status='READY' AND l.chat_id IS NOT NULL AND r.task_id IS NOT NULL
      AND r.status IN ('done','failed')`).all();
  const insert = db.prepare(`INSERT OR IGNORE INTO openmai_deliveries
    (delivery_id, task_id, consultant_id, project_id, chat_id, result_status,
     delivery_status, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`);
  let created = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      created += insert.run(randomUUID(), row.task_id, row.consultant_id, row.project_id,
        row.chat_id, row.status, at, at, at).changes;
      db.prepare(`UPDATE project_launches SET search_status=?, search_task_id=?, updated_at=?
        WHERE consultant_id=? AND project_id=?`).run(
        row.status === 'done' ? 'DONE' : 'FAILED', row.task_id, at, row.consultant_id, row.project_id,
      );
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return created;
}

function retryAt(at, attempts) {
  const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, attempts - 1)));
  return new Date(Date.parse(at) + delaySeconds * 1000).toISOString();
}

export async function deliverOpenmaiResultsOnce(db, dependencies = {}) {
  const at = dependencies.at || now();
  const enqueued = enqueueOpenmaiDeliveries(db, at);
  const rows = db.prepare(`SELECT d.*, r.result_text, r.error, j.company, j.role
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
          resultText: row.result_text, error: row.error, publicBaseUrl: dependencies.publicBaseUrl }),
        idempotencyKey: row.delivery_id,
      });
      db.prepare(`UPDATE openmai_deliveries SET delivery_status='SENT', message_id=?, last_error=NULL,
        sent_at=?, updated_at=? WHERE delivery_id=?`).run(output.message_id || null, at, at, row.delivery_id);
      sent += 1;
    } catch (error) {
      const attempts = row.attempts + 1;
      db.prepare(`UPDATE openmai_deliveries SET delivery_status='FAILED', next_attempt_at=?,
        last_error=?, updated_at=? WHERE delivery_id=?`).run(
        retryAt(at, attempts), String(error?.message || error).slice(0, 240), at, row.delivery_id,
      );
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
