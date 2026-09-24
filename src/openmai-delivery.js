/** OpenMai 最新结果 → 原飞书项目群；持久队列、脱敏卡片、有限重试。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { alignSoloAction } from './card-layout.js';
import { assessOpenmaiCandidateBatch, extractOpenmaiCandidates } from './openmai-result.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
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

export function groupSafeOpenmaiText(value, max = 6500) {
  const cleaned = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(PHONE, '[联系方式已隐藏]')
    .replace(EMAIL, '[联系方式已隐藏]')
    .trim();
  if (!cleaned) return 'OpenMai 已完成，但本轮没有返回可展示的候选人内容。';
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n\n*内容较长，完整结果请在工作台查看。*` : cleaned;
}

export function buildOpenmaiDeliveryCard({ job, status, resultText, error, publicBaseUrl,
  source = 'openmai' }) {
  // freeform = SuperMai 自由找人模式（无职位）：判据摘要替代 company/role，不放 deep link。
  // 项目模式 job.freeform 不传，行为不变（AGENTS.md §2 最小实现：复用同一函数）。
  const freeform = job?.freeform === true;
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const target = freeform ? null
    : buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: job.project_id });
  const success = status === 'done' || status === 'needs_input';
  const quality = success ? assessOpenmaiCandidateBatch(resultText) : null;
  const needsInput = status === 'needs_input' || quality?.needsInput;
  const complete = success && quality.complete;
  const candidates = success ? extractOpenmaiCandidates(resultText) : [];
  const searchRound = Math.max(1, Number(job.search_round || 1));
  // 2026-09-16 用户拍板：首轮才写「首轮」，其他轮次用「续搜」，不写「第 N 轮」。
  const roundWord = searchRound > 1 ? '续搜' : '首轮';
  const brand = freeform ? 'SuperMai 自由找人'
    : source === 'supermai' ? 'SuperMai 候选人推荐' : 'OpenMai 候选人推荐';
  const readyTitle = `${brand} · ${roundWord}已就绪`;
  const partialTitle = `${brand} · ${roundWord}候选人不足`;
  const headline = freeform
    ? `**自由找人 · ${groupSafeOpenmaiText(job.criteria, 60) || '未给判据'}**`
    : `**${job.company} · ${job.role}**`;
  const content = success
    ? (candidates.length
      ? `${headline}\n\n本轮共找到 ${candidates.length} 位候选人。`
        + (quality.message ? `\n\n> ${quality.message}` : '')
      : `${headline}\n\n${groupSafeOpenmaiText(resultText)}`)
    : `${headline}\n\n本轮候选人搜索失败：${groupSafeOpenmaiText(error, 500)}\n\n请修复连接后在工作台重试。`;
  const rows = candidates.length ? candidateFocusRows(job, candidates, source) : [];
  return {
    config: { wide_screen_mode: true },
    header: { template: complete ? 'green' : success ? 'orange' : 'red', title: { tag: 'plain_text',
      content: complete ? readyTitle
        : needsInput ? `${brand} · 请补充职位信息`
          : success ? partialTitle : `${brand} · 搜索失败` } },
    elements: [
      { tag: 'markdown', content },
      // 说明收成一行小灰字 note：按钮与候选人随行后不再需要长段教学。
      ...(candidates.length ? [focusIntroNote(source)] : []),
      ...rows,
      ...candidateQualityNotes(candidates, source),
      ...(candidates.length ? [continueSearchActions(job), continueSearchHint()] : []),
      // 失败 / 空结果卡只有这一个动作 → 右对齐收口（F4）。
      // freeform 无真实职位 → target 为 null → 不渲染「打开工作台」按钮，避免伪造链接（2026-09-16）。
      ...(!success || !candidates.length ? (target ? [alignSoloAction({ tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: success ? '打开工作台查看与评估' : '打开工作台处理' },
        multi_url: { url: target, pc_url: target, android_url: target, ios_url: target } }] })] : []) : []),
    ],
  };
}

/** 候选人每人一行：姓名直接打开 TTC，右侧只保留初筛通过与加入 reloop。
 *  三列权重 3/5/3，动作按钮纵向排列，确保四字姓名和两个动作都不被截断。 */
function candidateFocusRows(job, candidates, source) {
  const freeform = job?.freeform === true;
  return [
    { tag: 'column_set', flex_mode: 'none', background_style: 'grey',
      columns: [tableCell('候选人', 3), tableCell('匹配与背景 · 核心匹配', 5), tableCell('操作', 3)] },
    ...candidates.map((candidate, index) => {
      const info = [
        `**匹配度 ${groupSafeOpenmaiText(candidate.score, 20)}** · ${groupSafeOpenmaiText(candidate.role, 120)}`,
        backgroundText(candidate),
        groupSafeOpenmaiText(candidate.evaluation, 300),
      ].filter(Boolean).join('\n');
      const url = ttcTalentUrl(candidate) || (source === 'supermai' ? candidate.profileUrl : null);
      const name = groupSafeOpenmaiText(candidate.name, 12);
      return { tag: 'column_set', flex_mode: 'none',
        background_style: index % 2 === 0 ? 'default' : 'grey', columns: [
          // freeform：无 TTC 链接也做姓名按钮，对齐项目卡格式（链接放空不跳转，2026-09-16 specs/018 修订）
          { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: [url || freeform
              ? candidateLinkButton(url, index + 1, name)
              : { tag: 'div', text: { tag: 'plain_text', content: `${index + 1}. ${name}` } }] },
          { tag: 'column', width: 'weighted', weight: 5, vertical_align: 'top',
            elements: [{ tag: 'markdown', content: info }] },
          // freeform：无 PL 编号也做操作按钮占位（功能后续补，2026-09-16 specs/018 修订）
          { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: (candidate.candidateRefValid === false && !freeform)
              ? [{ tag: 'div', text: { tag: 'plain_text', content: '不可操作' } }]
              : [screenCandidateAction(job, candidate), addToReloopAction(job, candidate)] },
        ] };
    }),
  ];
}

function candidateLinkButton(url, no, name) {
  const btn = { tag: 'button', type: 'default', text: { tag: 'plain_text', content: `${no}. ${name}` } };
  // 有 TTC 链接才放 multi_url；无链接（freeform 外部找人）按钮存在但不跳转（2026-09-16 specs/018 修订）
  if (url) btn.multi_url = { url, pc_url: url, android_url: url, ios_url: url };
  return btn;
}

/** 一句话说明三个入口，避免用户先点开二次卡片才找到人才链接。 */
function focusIntroNote(source) {
  return { tag: 'note', elements: [{ tag: 'plain_text',
    content: source === 'supermai'
      ? '有来源链接时可点姓名查看官方资料；初筛通过与加入 reloop 是独立操作。'
      : '点姓名直接查看 TTC；初筛通过后发送人才链接；加入 reloop 为独立操作。' }] };
}

/** 表格原来的「操作」列兼作「链接待核实」提示，该列移除后信号改在这里披露，避免静默丢失。 */
function candidateQualityNotes(candidates, source) {
  const numbered = candidates.map((candidate, index) => ({ candidate, no: index + 1 }));
  const invalid = numbered.filter(({ candidate }) => candidate.candidateRefValid === false);
  const unverified = numbered.filter(({ candidate }) => candidate.candidateRefValid !== false
    && !ttcTalentUrl(candidate) && !(source === 'supermai' && candidate.profileUrl));
  const notes = [];
  if (invalid.length) notes.push(`${invalid.map(({ no }) => no).join('、')} 号候选人编号无效，未生成关注按钮`);
  if (unverified.length) notes.push(`${unverified.map(({ no }) => no).join('、')} 号 ${source === 'supermai' ? '来源资料' : 'TTC'} 链接待核实`);
  return notes.length
    ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: notes.join('；') }] }] : [];
}

function continueSearchActions(job) {
  // freeform：无 job_id，不放 OpenMai 继续找人（需 job_id）；放 SuperMai 重新找人按钮，
  // 引导用同判据重新触发。按钮先做占位对齐项目卡格式（2026-09-16 specs/018 修订）。
  if (job?.freeform === true) {
    const criteria = String(job.criteria || '').slice(0, 2000);
    const command = `[BRAINTEX_SEARCH_START] 自由找人继续：用本轮判据重新触发 brainx_supermai_scout。现在调用 brainx_supermai_scout，传 criteria（见下）。任务返回 running/triggered 后立即回复"正在重新找人，完成后候选人会自动发到本群"并结束本轮，不要原地轮询；如返回 already_done，提示顾问换判据措辞后重试。\ncriteria=${criteria}`;
    // 单按钮行用 alignSoloAction 右对齐收口（卡片排版规范，2026-09-16 specs/018 修订）
    return alignSoloAction({ tag: 'action', actions: [
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'SuperMai 重新找人' },
        value: { text: command } },
    ] });
  }
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const command = (entry, tool) => `[BRAINTEX_SEARCH_START] 为项目 ${projectRef} 使用 ${entry} 继续找人。读取本群最近一条由顾问明确发送的“找人条件：”作为可选补充条件；现在第一次调用 ${tool}，传入 job_id=${projectRef} 和 continue_search=true。任务返回 running/triggered 后立即回复“正在继续找人，完成后候选人会自动发到本群”并结束本轮，不要原地轮询。后续若顾问主动询问进度，查询时必须把 continue_search 改为 false 或省略，同一次按钮任务绝不能再次传 true。排除名单必须由 BrainX 根据历史 TTC 编号生成，不要自行编造，也不要再次询问找人方式。`;
  return { tag: 'action', actions: [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'OpenMai 继续找人' },
      value: { text: command('OpenMai', 'brainx_openmai_search') } },
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'SuperMai 继续找人' },
      value: { text: command('SuperMai', 'brainx_supermai_scout') } },
  ] };
}

/** 飞书 note 使用弱化灰字展示，不与候选事实或操作按钮争夺视觉层级。 */
function continueSearchHint() {
  return { tag: 'note', elements: [{ tag: 'plain_text',
    content: '继续找人时，先在群里发送“找人条件：……”，再点击上方继续找人；不发条件则按职位事实继续，并自动排除已推荐人选。' }] };
}

function tableCell(content, weight, elements) {
  return {
    tag: 'column', width: 'weighted', weight, vertical_align: 'top',
    elements: elements || [{ tag: 'div', text: { tag: 'plain_text', content } }],
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
  // 仅 PL 编号是有效 TTC 人才编号（2026-09-16 JWT 实证：PT 外部渠道编号 TTC 查无此人），
  // 其余一律不拼链接，姓名列降级为纯文本。
  if (!/^PL\d{10,}$/.test(String(candidate.candidateRef || ''))) return null;
  return `https://app.ttcadvisory.com/app/talent/${encodeURIComponent(candidate.candidateRef)}`;
}

export function screenCandidateAction(job, candidate) {
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const command = `[BRAINTEX_CANDIDATE_KEEP] 把项目 ${projectRef} 的候选人 ${candidate.candidateRef} 初筛通过。`
    + '这个按钮就是我的明确确认：现在调用 brainx_candidate_workflow，'
    + `传入 job_id=${projectRef}、candidate_ref=${candidate.candidateRef}、`
    + 'action=KEEP_FOR_REVIEW、confirm=true。成功后告诉群里“已初筛通过”，'
    + '并说明此人已进入本项目共享上下文，同时已发送 TTC 人才链接；不要发送简历。';
  return { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '初筛通过' },
    value: { text: command } };
}

export function addToReloopAction(job, candidate) {
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '加入reloop' },
    value: { text: `[BRAINTEX_TALENT_ADD] 职位 ${projectRef} 候选人 ${candidate.candidateRef}` } };
}

/** F8：中文数据在 372px 内摆不开，「7 年 · 深圳」会被折成「7 年 · 深\n圳」。
 *  把「经验 / 城市」与「学历」并成一行「背景」（`7 年 · 深圳 · 硕士 · 哈工大`），
 *  候选人信息列立刻宽裕。
 *  上游缺字段时会填「待核实」占位，直接拼会出现「待核实 · 待核实 · 待核实」，
 *  因此先剔除空值与占位、再去重，全空才回退成单个「待核实」。 */
function backgroundText(candidate) {
  const parts = [candidate.experience, candidate.city, candidate.education]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '待核实');
  return [...new Set(parts.map((value) => groupSafeOpenmaiText(value, 40)))].join(' · ') || '待核实';
}

export function enqueueOpenmaiDeliveries(db, at = now()) {
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
  const source = String(row.task_id || '').startsWith('sm_') ? 'SUPERMAI' : 'OPENMAI';
  db.prepare(`UPDATE project_launches SET search_status=?, search_task_id=?, error_code=?,
    error_message=?, updated_at=? WHERE launch_id=(SELECT launch_id FROM project_launches
      WHERE project_id=? ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
        WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, created_at, launch_id LIMIT 1)`).run(
    failed || incomplete ? 'FAILED' : 'DONE', row.task_id,
    failed ? `${source}_SEARCH_FAILED` : quality?.needsInput ? `${source}_SEARCH_BRIEF_REQUIRED`
      : incomplete ? `${source}_CANDIDATES_INCOMPLETE` : null,
    failed ? String(row.error || `${source === 'SUPERMAI' ? 'SuperMai' : 'OpenMai'} 搜索失败`).slice(0, 240)
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
    WHERE status='running' AND task_id LIKE 'om_%' AND started_at<=?`).all(cutoff);
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
