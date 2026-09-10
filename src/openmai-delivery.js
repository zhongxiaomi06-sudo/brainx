/** OpenMai 最新结果 → 原飞书项目群；持久队列、脱敏卡片、有限重试。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { assessOpenmaiCandidateBatch, extractOpenmaiCandidates } from './openmai-result.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_RESUME_BYTES = 12 * 1024 * 1024;
const STALE_SEARCH_MS = 60 * 60 * 1000;

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
  const success = status === 'done' || status === 'needs_input';
  const quality = success ? assessOpenmaiCandidateBatch(resultText) : null;
  const needsInput = status === 'needs_input' || quality?.needsInput;
  const complete = success && quality.complete;
  const candidates = success ? extractOpenmaiCandidates(resultText) : [];
  const searchRound = Math.max(1, Number(job.search_round || 1));
  const roundLabel = searchRound > 1 ? `第 ${searchRound} 轮 · ` : '';
  const content = success
    ? (candidates.length
      ? `**${job.company} · ${job.role}**\n\n${roundLabel}本轮共找到 ${candidates.length} 位候选人。`
        + (quality.message ? `\n\n> ⚠️ ${quality.message}` : '')
      : `**${job.company} · ${job.role}**\n\n${groupSafeOpenmaiText(resultText)}`)
    : `**${job.company} · ${job.role}**\n\n本轮候选人搜索失败：${groupSafeOpenmaiText(error, 500)}\n\n请修复连接后在工作台重试。`;
  const table = candidates.length ? [
    candidateTableHeading(),
    ...candidates.flatMap((candidate, index) => candidateTableRow({
      candidate, index, job, baseUrl,
    })),
  ] : [];
  return {
    config: { wide_screen_mode: true },
    header: { template: complete ? 'green' : success ? 'orange' : 'red', title: { tag: 'plain_text',
      content: complete ? 'BrainTex · 首轮候选人已就绪'
        : needsInput ? 'BrainTex · 请补充岗位画像'
          : success ? 'BrainTex · 首轮候选人不足' : 'BrainTex · 候选人搜索失败' } },
    elements: [
      { tag: 'markdown', content },
      ...table,
      ...(candidates.length ? [continueSearchActions(job)] : []),
      ...(!success || !candidates.length ? [{ tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: success ? '打开工作台查看与评估' : '打开工作台处理' },
        multi_url: { url: target, pc_url: target, android_url: target, ios_url: target } }] }] : []),
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: '“重点关注”会加入项目共同重点名单，并立即在群里投放带 TTC 链接的人才卡' }] },
    ],
  };
}

function continueSearchActions(job) {
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const command = (entry, tool) => `为项目 ${projectRef} 使用 ${entry} 继续找人。读取本群最近一条由顾问明确发送的“找人条件：”作为可选补充条件；现在调用 ${tool}，传入 job_id=${projectRef} 和 continue_search=true。排除名单必须由 BrainX 根据历史 TTC 编号生成，不要自行编造，也不要再次询问找人方式。`;
  return { tag: 'action', actions: [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'OpenMai 继续找人' },
      value: { text: command('OpenMai', 'brainx_openmai_search') } },
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'SuperMai 继续找人' },
      value: { text: command('SuperMai', 'brainx_supermai_scout') } },
  ] };
}

function tableCell(content, weight, elements) {
  return {
    tag: 'column', width: 'weighted', weight, vertical_align: 'top',
    elements: elements || [{ tag: 'div', text: { tag: 'plain_text', content } }],
  };
}

function candidateTableHeading() {
  return {
    tag: 'column_set', flex_mode: 'none', background_style: 'grey',
    columns: [tableCell('候选人 / 当前岗位', 3), tableCell('经验 / 城市', 2),
      tableCell('学历', 2), tableCell('核心匹配', 4), tableCell('匹配度', 1), tableCell('操作', 2)],
  };
}

function ttcTalentUrl(candidate) {
  if (candidate.talentUrl) {
    try {
      const target = new URL(candidate.talentUrl);
      if (target.origin === 'https://app.ttcadvisory.com' && target.pathname.startsWith('/app/talent/')) {
        return target.toString();
      }
    } catch { /* 使用候选编号回退。 */ }
  }
  if (candidate.candidateRefValid === false) return null;
  return `https://app.ttcadvisory.com/app/talent/${encodeURIComponent(candidate.candidateRef)}`;
}

function keepCandidateAction(job, candidate) {
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const command = `把项目 ${projectRef} 的候选人 ${candidate.candidateRef} 标记为重点关注。`
    + '这个按钮就是我的明确确认：现在调用 brainx_candidate_workflow，'
    + `传入 job_id=${projectRef}、candidate_ref=${candidate.candidateRef}、`
    + 'action=KEEP_FOR_REVIEW、confirm=true。成功后告诉群里“☑ 已重点关注”，'
    + '并说明此人已进入本项目共享上下文，同时已发送人才卡；不要发送简历。';
  return { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '重点关注' },
    value: { text: command } };
}

function candidateTableRow({ candidate, index, job, baseUrl }) {
  void baseUrl;
  const detailUrl = ttcTalentUrl(candidate);
  const action = detailUrl ? []
    : [{ tag: 'div', text: { tag: 'plain_text', content: '链接待核实' } }];
  if (candidate.candidateRefValid !== false) {
    action.push(keepCandidateAction(job, candidate));
  }
  return [
    { tag: 'column_set', flex_mode: 'none', background_style: 'default', columns: [
      tableCell(`${index + 1}. ${groupSafeOpenmaiText(candidate.name, 60)}\n${groupSafeOpenmaiText(candidate.role, 120)}`, 3),
      tableCell(`${groupSafeOpenmaiText(candidate.experience, 40)} · ${groupSafeOpenmaiText(candidate.city, 40)}`, 2),
      tableCell(groupSafeOpenmaiText(candidate.education, 80), 2),
      tableCell(groupSafeOpenmaiText(candidate.evaluation, 300), 4),
      tableCell(groupSafeOpenmaiText(candidate.score, 20), 1),
      tableCell('', 2, action),
    ] },
  ];
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
      AND r.status IN ('done','needs_input','failed')`).all();
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
  const rows = db.prepare(`SELECT d.*, r.result_text, r.error, r.search_round, j.company, j.role
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
