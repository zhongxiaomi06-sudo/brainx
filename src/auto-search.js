/** auto-search.js — 建群后按 JD 自动第一轮找人 + 凭证失效 agent 私聊主动提醒（specs/037）。
 *
 * 咪 2026-10-15 指令：「建群之后按照 JD 就开始第一轮的找人 不要用户说开始找人
 * 后续能一直长期招人」+「不能（按职位层级调整判据） 要提醒然后把连接直接给出
 * 暂时不给上限」+「除了 mia 之外的群都实现自动触发」。
 *
 * 入口：accept-launch.js#postAcceptSideEffects 建群成功后调用 autoSearchOnLaunch；
 *      bin/brainx-auto-search-retrofill.mjs 对存量 READY 群回填触发。
 *
 * 关键设计：
 * 1. 判据底座（specs/040 S1）：JD 原文（notes/raw_json.notes）经 sanitize 剥歧视条件后
 *    入判据；年限优先取 JD 显式区间，解析不出才兜底「3-5 年」（咪 2026-10-15 拍板默认）
 * 2. 凭证失效 agent 私聊主动提醒 + 直接给工作台 URL（咪拍板 §4.4.1）
 * 3. 不设单项目每月上限（咪拍板只靠 kill switch 软控 §4.4.2）
 * 4. 跳过 consultant_id='mia'（咪拍板除 mia 外都触发）
 *
 * 多级 kill switch：全局 BRAINX_AUTO_SEARCH_ENABLED=0 + 项目级 auto_search_enabled=0
 *                  + 凭证 needs_reauth=1 + active_state!=OPEN
 */
import { now, uuid } from './db.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { productionBaseUrl } from './brainx-deep-links.js';
import { startSupermaiScoutTask } from './supermai-sourcing.js';
import { getAuthorizedTtcJwt } from './ttcsdk/auth.js';
import { compileSearchCriteria } from './criteria-compile.js';

/** TTC 招聘漏斗计数模式（2026-10-15 审查实证）。
 *  job_facts.pipeline 字段 72.1%（17279/23964 行）实为 TTC 漏斗计数而非业务描述，
 *  例如 "Interview×38 Offer×1 Onboarding×2 Recommendation×106 Sourcing×37"。
 *  直接拼进判据会污染自然语言语义，导致引擎误判甚至零结果——
 *  铁证：sm_bafc5d0f（Java后端，判据含 Interview×18 Offer×1 Recommendation×66）
 *  → 0 候选人，而同批干净判据均返回 8-10 人。 */
const PIPELINE_NOISE_RE =
  /\b(?:Interview|Offer|Recommendation|Sourcing|Onboarding|Hired|Rejected|Shortlist|Screening)\s*×\s*\d+/gi;

/** 清洗 pipeline：去掉漏斗计数片段，返回业务描述或 null（全为噪声时）。 */
export function cleanPipeline(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text === 'null' || text === 'NULL') return null;
  const cleaned = text
    .replace(PIPELINE_NOISE_RE, ' ')
    .replace(/\s*[,，、;；]\s*/g, '，')
    .replace(/\s+/g, ' ')
    .replace(/^[\s，、]+|[\s，、]+$/g, '')
    .trim();
  // 清洗后只剩空/纯分隔符 → 判定为无有效业务描述
  if (!cleaned || !/[\u4e00-\u9fa5A-Za-z0-9]/.test(cleaned)) return null;
  return cleaned;
}

/** JD 原文取值（specs/040 S1）：job.notes 权威列优先，raw_json.notes/requirements 兜底。
 *  两个调用方（autoSearchOnLaunch / retrofill）都是 SELECT *，raw_json 天然在场。 */
export function jobNotesText(job) {
  if (job?.notes && String(job.notes).trim()) return job.notes;
  try {
    const raw = JSON.parse(job?.raw_json || '{}');
    for (const key of ['notes', 'requirements']) {
      if (typeof raw?.[key] === 'string' && raw[key].trim()) return raw[key];
    }
  } catch { /* raw_json 损坏不阻塞判据生成 */ }
  return null;
}

/** JD 原文净化（specs/040 S1）：剥年龄/性别等歧视性或不可执行条件 + 规整空白，截前 500 字。
 *  S2 编译层出参与 S3 校验复用同一函数（双重 sanitize 的出参侧）。 */
export function sanitizeJdNotes(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/\r\n/g, '\n');
  // 年龄类：年龄限制：XX / 30岁以内 / 35 岁以下（分段吃掉后续短语避免留残句）
  t = t.replace(/年龄限制[：:]?[^\n。；;]*[。；;\n]?/g, '');
  t = t.replace(/\d{2}\s*岁以[内下][^\n。；;,，]*[。；;\n,，]?/g, '');
  // 年龄类补充（2026-10-21 生产回放实证：95后/90后 179 行漏剥，如 J1L0502「95后 对标公司」）。
  // token 级剥离只吃歧视词本身，不吃后续短语——「95后 对标公司 可靠性经验」须保留业务信息。
  // (?<![\d年]) 排除「2010年后/10年后」类时间表述误伤。
  t = t.replace(/(?<![\d年])(?:[89]\d|00)后(?:优先)?\s*/g, '');
  t = t.replace(/不?超过\s*\d{1,2}\s*岁[^\n。；;,，]*[。；;\n,，]?/g, '');
  // 性别类（f94b3d3 先例：引擎已约束不转 gender 过滤，判据侧同步不供给）
  t = t.replace(/(女|男)生?优先[^\n。；;,，]*[。；;\n,，]?/g, '');
  t = t.replace(/限(女|男)性[^\n。；;,，]*[。；;\n,，]?/g, '');
  t = t.replace(/只要(女|男)(性|的)?\s*/g, '');
  t = t.replace(/(女|男)性?为佳\s*/g, '');
  // 压缩空白，截前 500 字（旧 jdText 分支 200 字太短：J3ZJYBB 职责列表 200 字只到一半）
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return t ? t.slice(0, 500) : null;
}

/** 解析显式年限区间（specs/040 S1）：「3-8年」「3-8 年工作经验」「5 年以上」
 *  → '3-8 年' / '5 年以上'；解析不出返回 null（调用方兜底 3-5 年）。
 *  (?<!\d)/(?!\d) 防止在「2024-2025年」这类长数字串里误匹配。 */
export function parseExperienceRange(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/(?<!\d)(\d{1,2})\s*[-–~至]\s*(\d{1,2})\s*年(?!\d)/);
  if (m) return `${m[1]}-${m[2]} 年`;
  const m2 = s.match(/(?<!\d)(\d{1,2})\s*年以上/);
  if (m2) return `${m2[1]} 年以上`;
  return null;
}

/** 从 job_facts 拼「按 JD 自动找人」判据（specs/040 S1 规则底座）。
 *  JD 原文要点 + 真实年限区间优先；无 notes 时兜底固定 3-5 年（咪拍板）。 */
export function buildAutoSearchCriteria(job, jdText = null) {
  if (!job || (!job.role && !job.company)) return null;

  const parts = [];
  if (job.role) parts.push(job.role);
  if (job.city) parts.push(job.city);
  if (job.hc) parts.push(`${job.hc}人`);
  // specs/040【改 1】：不再拼「X背景」（给 X 公司的岗位找 X 背景的人＝语义倒置），
  // 改括号标注招聘方。铁证：JH46A56 案 0/10 命中「Zettlab 背景」。
  if (job.company) parts.push(`（招聘方：${job.company}）`);
  // 只在 pipeline 含真实业务描述时才拼（漏斗计数已清洗掉）
  const pipeline = cleanPipeline(job.pipeline);
  if (pipeline) parts.push(`主要做${pipeline}`);

  // specs/040【改 3】：JD 原文入判据。job.notes/raw_json.notes 优先于外部 jdText
  //（库内权威列比对话文本可信）；此前 jdText 分支在生产从未执行过（接线缺口）。
  const notes = sanitizeJdNotes(jobNotesText(job)) || sanitizeJdNotes(jdText);
  if (notes) parts.push(`JD 原文要点：${notes}`);

  // specs/040【改 4】：JD 含显式年限区间时用真实值，否则保留 3-5 年兜底（咪拍板默认）
  const years = parseExperienceRange(notes) || '3-5 年';
  parts.push(`${years}工作经验`);

  return parts.join('，');
}

/** 即时反馈卡：群里发「正在按 JD 找人，通常 3-5 分钟」。 */
function buildSearchStartCard({ consultantId, projectId, task_id, criteria, round = 1 }) {
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'BrainTex 自动找人启动' } },
    elements: [
      { tag: 'markdown', content: `**项目 ${projectId} · 第 ${round} 轮**\n按 JD 自动触发找人，通常需要 3-5 分钟；完成后候选人会自动发到本群。` },
      { tag: 'markdown', content: `**判据**：${String(criteria || '').slice(0, 400)}` },
      { tag: 'markdown', content: `任务号：${task_id}` },
    ],
  };
}

/** 凭证失效 agent 私聊主动提醒卡（咪拍板：要提醒 + 直接给连接）。 */
function buildCredentialExpiredCard({ consultantName, affectedProjects, publicBaseUrl }) {
  const projectList = (affectedProjects || []).slice(0, 10).join('、') || '无';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'BrainTex 凭证提醒' } },
    elements: [
      { tag: 'markdown', content: `${consultantName ? `**${consultantName}**，` : ''}你的 TTC 凭证已失效，无法自动触发项目找人。` },
      { tag: 'markdown', content: `**请打开 BrainTex 工作台更新凭证**：\n${publicBaseUrl}\n\n路径：登录工作台 → 设置中心 → 「TTC 职位系统」→ 点「更新凭证」按钮粘贴新的 TTC JWT。\n\n凭证更新后，下次自动找人会自动恢复（无需手动触发）。` },
      { tag: 'markdown', content: `**当前受影响项目**：${projectList}` },
      { tag: 'action', actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开工作台' },
          multi_url: { url: publicBaseUrl, pc_url: publicBaseUrl, android_url: publicBaseUrl, ios_url: publicBaseUrl } },
      ] },
    ],
  };
}

/** 凭证失效 agent 私聊主动提醒（咪拍板 §4.4.1）。
 *  幂等键 notify:cred-expired:<cid>:<YYYY-MM-DD>（同一天不重复提醒，避免 spam）。 */
export async function notifyCredentialExpired(db, consultantId, affectedProjects = []) {
  const consultant = db.prepare('SELECT open_id, display_name FROM consultants WHERE consultant_id=?').get(consultantId);
  if (!consultant?.open_id) return { status: 'no_open_id', consultantId };

  // 幂等：同一天不重复提醒
  const today = new Date().toISOString().split('T')[0];
  const idemKey = `notify:cred-expired:${consultantId}:${today}`;
  const existing = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?').get(idemKey);
  if (existing) return { status: 'already_notified_today', consultantId, idemKey };

  let publicBaseUrl;
  try { publicBaseUrl = productionBaseUrl().href; }
  catch { publicBaseUrl = 'https://base.yorkteam.cn'; }

  const card = buildCredentialExpiredCard({
    consultantName: consultant.display_name,
    affectedProjects,
    publicBaseUrl,
  });

  try {
    await sendInteractiveCard({ target: consultant.open_id, card, idempotencyKey: idemKey });
    // 记入 workflow_event_log 作为幂等账本
    db.prepare(`INSERT OR IGNORE INTO workflow_event_log
      (event_id, idem_key, event_type, case_id, actor, occurred_at, payload, evidence_refs, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), idemKey, 'credential.expired_notified', null,
        'system:auto-search', now(), JSON.stringify({ consultantId, affectedProjects, publicBaseUrl }), '[]', 1);
    return { status: 'notified', consultantId, open_id: consultant.open_id, idemKey, affectedProjects };
  } catch (e) {
    return { status: 'failed', consultantId, error: String(e.message || e).slice(0, 200) };
  }
}

/** 建群后自动触发第一轮找人（specs/037 P0 主入口）。
 *  跳过 consultant_id='mia'（咪拍板除 mia 外都触发）。 */
export async function autoSearchOnLaunch(db, bus, deps, consultantId, projectId, projectLaunch) {
  // 0. 全局开关
  if (process.env.BRAINX_AUTO_SEARCH_ENABLED === '0') {
    return { status: 'disabled_global', reason: 'BRAINX_AUTO_SEARCH_ENABLED=0' };
  }

  // 1. 咪拍板：跳过 mia
  if (consultantId === 'mia') {
    return { status: 'skipped_mia', reason: '咪拍板：除 mia 外都自动触发' };
  }

  // 2. 项目级开关（首次 READY 默认 1）
  const enabled = db.prepare('SELECT auto_search_enabled FROM project_launches WHERE launch_id=?')
    .get(projectLaunch.launch_id)?.auto_search_enabled;
  if (enabled === 0) {
    return { status: 'disabled_project', reason: 'auto_search_enabled=0' };
  }

  // 3. 凭证 fail-fast
  const jwt = getAuthorizedTtcJwt(db, consultantId, 'OPENMAI');
  if (!jwt) {
    // 咪拍板 §4.4.1：凭证失效不阻塞接单返回，agent 私聊主动提醒 + 直接给工作台 URL
    await notifyCredentialExpired(db, consultantId, [projectId]);
    return { status: 'no_jwt', reason: 'TTC 凭证失效，已私聊提醒顾问更新凭证', consultantId };
  }

  // 4. 判据生成（specs/040：S1 规则底座 + S2 LLM 编译层；降级链见 criteria-compile.js）
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(projectId);
  if (!job) {
    return { status: 'no_job', reason: 'job_facts 无此职位', projectId };
  }
  const compiledOut = await compileSearchCriteria(db, job, { projectId, round: 1 });
  const criteria = compiledOut.criteria;
  if (!criteria) {
    return { status: 'no_criteria', reason: 'job_facts 缺字段无法生成判据', projectId };
  }

  // 5. 幂等触发（防多服务并发重复触发）
  const existing = db.prepare(`SELECT task_id, status FROM openmai_results
    WHERE project_id=? AND consultant_id=? AND search_round=1`)
    .get(projectId, consultantId);
  if (existing?.status === 'done') {
    return { status: 'already_done', task_id: existing.task_id, projectId, consultantId };
  }

  // 6. 触发 SuperMai 找人（fire-and-forget OK：常驻 brainx 服务进程内 IIFE 不死）。
  //    try/catch 防御（2026-10-21 审查）：effectiveSearchBrief 拼接超长会 throw
  //    SEARCH_BRIEF_TOO_LONG——判据环节异常不得炸掉接单链路（建群已成功，不能回滚）。
  let out;
  try {
    out = startSupermaiScoutTask(db, bus, consultantId, criteria, {
      projectId, autoSearch: true, round: 1,
    });
  } catch (e) {
    return { status: 'trigger_error', reason: String(e?.message || e).slice(0, 200), projectId, consultantId };
  }

  if (out.status === 'triggered') {
    // 7. 即时反馈卡（候选结果由 openmai-delivery worker 投递回群）
    try {
      await sendInteractiveCard({
        target: projectLaunch.chat_id,
        card: buildSearchStartCard({
          consultantId, projectId, task_id: out.task_id, criteria, round: 1,
        }),
      });
    } catch (e) {
      // 卡片失败不阻塞接单（候选结果由 worker 投递兜底）
      return { status: 'triggered_no_card', task_id: out.task_id, error: String(e.message || e).slice(0, 200) };
    }
  }

  return out;
}

/** 回填扫描：查所有 READY search_status NULL 群（跳过 mia）触发自动找人。
 *  bin/brainx-auto-search-retrofill.mjs 调用。 */
export function listRetrofillCandidates(db) {
  return db.prepare(`
    SELECT pl.launch_id, pl.consultant_id, pl.project_id, pl.chat_id, pl.status,
           pl.search_status, pl.created_at,
           jf.company, jf.role, jf.city, jf.hc, jf.pipeline, jf.active_state
    FROM project_launches pl
    JOIN job_facts jf ON jf.project_id=pl.project_id
    WHERE pl.status='READY' AND (pl.search_status IS NULL OR pl.search_status='')
      AND pl.consultant_id != 'mia'
    ORDER BY pl.created_at DESC
  `).all();
}
