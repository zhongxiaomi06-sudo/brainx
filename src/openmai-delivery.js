/** OpenMai 最新结果 → 原飞书项目群；持久队列、脱敏卡片、有限重试。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { sendInteractiveCard, sendPdfFile, replyInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { getValidTtcJwt } from './ttcsdk/auth.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CANDIDATE_BLOCK = /<!--\s*BRAINX_CANDIDATES_V1\s*([\s\S]*?)-->/;
const MAX_RESUME_BYTES = 12 * 1024 * 1024;
const STALE_SEARCH_MS = 60 * 60 * 1000;

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

export function assessOpenmaiCandidateBatch(value) {
  const hasMachineBlock = CANDIDATE_BLOCK.test(String(value || ''));
  const count = extractOpenmaiCandidates(value).length;
  return {
    count,
    hasMachineBlock,
    complete: !hasMachineBlock || count >= 6,
    message: hasMachineBlock && count < 6
      ? `OpenMai 本轮仅返回 ${count} 名结构化候选人，未达到首轮 6–10 人目标；已保留现有结果，请明确重试补充。`
      : null,
  };
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

function isPermanentResumeError(error) {
  return ['RESUME_URL_INVALID', 'RESUME_URL_NOT_TRUSTED', 'RESUME_PDF_INVALID', 'RESUME_PDF_TOO_LARGE']
    .includes(error?.message);
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
      { tag: 'markdown', content: `候选编号：${candidate.candidateRef}\n\n**AI 初评**\n${evaluation}` },
      { tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: '打开候选人评估' },
        multi_url: { url: target, pc_url: target, android_url: target, ios_url: target } }] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: candidate.resumeUrl
        ? 'PDF 简历将回复在本话题 · 可在此让机器人记录联系与推进状态'
        : '本轮未取得真实 PDF · 可在此让机器人记录联系与推进状态' }] },
    ],
  };
}

export function buildResumeUnavailableCard(candidate) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '简历附件待核验' } },
    elements: [
      { tag: 'markdown', content: `**${groupSafeOpenmaiText(candidate.name, 60)}** 的真实 PDF 未能通过安全下载或文件校验。` },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: '本候选人的评估已保留；请在工作台核对来源附件，不会阻断其他候选人投递。' }] },
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
    try {
      const bytes = await downloadResumePdf(candidate.resumeUrl, jwt, dependencies);
      await (dependencies.sendPdfFile || sendPdfFile)({
        target: row.chat_id, data: bytes, fileName: `${candidate.name}-简历.pdf`,
        idempotencyKey: `${row.delivery_id}-resume-${index + 1}`,
        replyToMessageId: topic.message_id,
      });
    } catch (error) {
      if (!isPermanentResumeError(error)) throw error;
      await (dependencies.replyInteractiveCard || replyInteractiveCard)({
        messageId: topic.message_id,
        card: buildResumeUnavailableCard(candidate),
        idempotencyKey: `${row.delivery_id}-resume-warning-${index + 1}`,
      });
    }
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
  const quality = success ? assessOpenmaiCandidateBatch(resultText) : null;
  const complete = success && quality.complete;
  const content = success
    ? `**${job.company} · ${job.role}**\n\n${groupSafeOpenmaiText(resultText)}`
      + (quality.message ? `\n\n> ⚠️ ${quality.message}` : '')
    : `**${job.company} · ${job.role}**\n\n本轮候选人搜索失败：${groupSafeOpenmaiText(error, 500)}\n\n请修复连接后在工作台重试。`;
  return {
    config: { wide_screen_mode: true },
    header: { template: complete ? 'green' : success ? 'orange' : 'red', title: { tag: 'plain_text',
      content: complete ? 'BrainTex · 首轮候选人已就绪'
        : success ? 'BrainTex · 首轮候选人不足' : 'BrainTex · 候选人搜索失败' } },
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
  const rows = db.prepare(`SELECT r.task_id, r.consultant_id, r.project_id, r.status, r.result_text,
      l.launch_id, l.chat_id
    FROM openmai_results r JOIN project_launches l
      ON l.launch_id=(SELECT pl.launch_id FROM project_launches pl
        WHERE pl.project_id=r.project_id
        ORDER BY CASE pl.status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
          WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, pl.created_at, pl.launch_id LIMIT 1)
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
  const quality = row.result_status === 'done' ? assessOpenmaiCandidateBatch(row.result_text) : null;
  const incomplete = quality && !quality.complete;
  const failed = row.result_status === 'failed';
  db.prepare(`UPDATE project_launches SET search_status=?, search_task_id=?, error_code=?,
    error_message=?, updated_at=? WHERE launch_id=(SELECT launch_id FROM project_launches
      WHERE project_id=? ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
        WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, created_at, launch_id LIMIT 1)`).run(
    failed || incomplete ? 'FAILED' : 'DONE', row.task_id,
    failed ? 'OPENMAI_SEARCH_FAILED' : incomplete ? 'OPENMAI_CANDIDATES_INCOMPLETE' : null,
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
    for (const row of rows) recovered += update.run(at, row.project_id,
      row.consultant_id, row.task_id).changes;
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return recovered;
}

function retryAt(at, attempts) {
  const delaySeconds = Math.min(300, 5 * (2 ** Math.max(0, attempts - 1)));
  return new Date(Date.parse(at) + delaySeconds * 1000).toISOString();
}

export async function deliverOpenmaiResultsOnce(db, dependencies = {}) {
  const at = dependencies.at || now();
  failStaleOpenmaiTasks(db, at, dependencies.staleSearchMs || STALE_SEARCH_MS);
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
