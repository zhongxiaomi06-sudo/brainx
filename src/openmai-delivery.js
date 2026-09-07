/** OpenMai 最新结果 → 原飞书项目群；持久队列、脱敏卡片、有限重试。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { sendInteractiveCard, sendPdfFile } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { getValidTtcJwt } from './ttcsdk/auth.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CANDIDATE_BLOCK = /<!--\s*BRAINX_CANDIDATES_V1\s*([\s\S]*?)-->/;
const MAX_RESUME_BYTES = 12 * 1024 * 1024;

export function extractOpenmaiCandidates(value) {
  const match = String(value || '').match(CANDIDATE_BLOCK);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1].trim());
    if (!Array.isArray(parsed?.candidates)) return [];
    return parsed.candidates.slice(0, 10).map((item, index) => ({
      candidateRef: String(item?.candidate_ref || `candidate-${index + 1}`).slice(0, 100),
      name: String(item?.name || `候选人${index + 1}`).slice(0, 60),
      evaluation: String(item?.evaluation || '待顾问核验').slice(0, 300),
      resumeUrl: typeof item?.resume_url === 'string' ? item.resume_url : null,
    }));
  } catch { return []; }
}

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
  if (response.ok === false || announced > MAX_RESUME_BYTES) throw new Error('RESUME_DOWNLOAD_FAILED');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESUME_BYTES
      || !bytes.subarray(0, Math.min(1024, bytes.length)).includes(Buffer.from('%PDF-'))) {
    throw new Error('RESUME_PDF_INVALID');
  }
  return bytes;
}

export function buildCandidateTopicCard({ candidate, job, publicBaseUrl }) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const target = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity',
    objectRef: job.project_id, candidateRef: candidate.candidateRef });
  const name = groupSafeOpenmaiText(candidate.name, 60);
  const evaluation = groupSafeOpenmaiText(candidate.evaluation, 1000);
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `候选人 · ${name}` } },
    elements: [
      { tag: 'markdown', content: `**AI 初评**\n${evaluation}` },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: '打开候选人评估' },
        multi_url: { url: target, pc_url: target, android_url: target, ios_url: target } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: candidate.resumeUrl
        ? 'PDF 简历将回复在本话题 · 联系与推进记录请继续写在本话题'
        : '本轮未取得真实 PDF · 联系与推进记录请继续写在本话题' }] },
    ],
  };
}

async function deliverCandidateTopics(db, row, dependencies) {
  const candidates = extractOpenmaiCandidates(row.result_text);
  if (candidates.length === 0) return 0;
  const send = dependencies.sendInteractiveCard || sendInteractiveCard;
  const withResume = candidates.some((candidate) => candidate.resumeUrl);
  const jwt = withResume ? getValidTtcJwt(db, row.consultant_id) : null;
  if (withResume && !jwt) throw new Error('TTC_CREDENTIALS_REQUIRED_FOR_RESUME');
  let sent = 0;
  for (const [index, candidate] of candidates.entries()) {
    const topic = await send({
      target: row.chat_id,
      card: buildCandidateTopicCard({ candidate, job: row, publicBaseUrl: dependencies.publicBaseUrl }),
      idempotencyKey: `${row.delivery_id}-candidate-${index + 1}`,
    });
    sent++;
    if (!candidate.resumeUrl) continue;
    if (!topic.message_id) throw new Error('FEISHU_CANDIDATE_TOPIC_MESSAGE_ID_MISSING');
    const bytes = await downloadResumePdf(candidate.resumeUrl, jwt, dependencies);
    await (dependencies.sendPdfFile || sendPdfFile)({
      target: row.chat_id, data: bytes, fileName: `${candidate.name}-简历.pdf`,
      idempotencyKey: `${row.delivery_id}-resume-${index + 1}`,
      replyToMessageId: topic.message_id,
    });
  }
  return sent;
}

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
      if (row.result_status === 'done') await deliverCandidateTopics(db, row, dependencies);
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
