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
 * 1. 判据固定「3-5 年经验」（咪拍板不按职位层级调整）
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

/** 从 job_facts 拼「按 JD 自动找人」判据。固定 3-5 年（咪拍板）。 */
export function buildAutoSearchCriteria(job, jdText = null) {
  if (!job || (!job.role && !job.company)) return null;

  const parts = [];
  if (job.role) parts.push(job.role);
  if (job.city) parts.push(job.city);
  if (job.hc) parts.push(`${job.hc}人`);
  if (job.company) parts.push(`${job.company}背景`);
  if (job.pipeline) parts.push(`主要做${job.pipeline}`);

  if (jdText) {
    const skills = jdText.substring(0, 200).replace(/\s+/g, ' ');
    parts.push(`技能要求：${skills}`);
  }

  // 咪 2026-10-15 拍板：固定 3-5 年（不按职位层级调整）
  parts.push('3-5 年工作经验');

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

  // 4. 判据生成（咪拍板固定 3-5 年）
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(projectId);
  if (!job) {
    return { status: 'no_job', reason: 'job_facts 无此职位', projectId };
  }
  const criteria = buildAutoSearchCriteria(job);
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

  // 6. 触发 SuperMai 找人（fire-and-forget OK：常驻 brainx 服务进程内 IIFE 不死）
  const out = startSupermaiScoutTask(db, bus, consultantId, criteria, {
    projectId, autoSearch: true, round: 1,
  });

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
