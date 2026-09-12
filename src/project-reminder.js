/** project-reminder.js — 项目轻量提醒（specs/009，2026-09-10）。
 *
 * 项目群连续无操作（默认 72h）后，机器人主动在群里发一张轻量提醒卡：
 * 询问项目是否继续、后续推人目标与对应时间节点（全部读 SQLite 上下文，零 LLM 成本）。
 * 目标/时间节点不准时顾问直接在群里回复修正（openclaw 已有对话与 record_job_progress 能力）。
 *
 * 规则（specs/009）：
 *  - 对象：project_launches READY 且有 chat_id，承接状态 ACCEPTED；
 *  - 静默：MAX(lark_messages/decision_events/job_outcomes/openmai_results/commitment_actions/
 *    project_launches 的时间) 距今超过阈值（BRAINX_PROJECT_REMINDER_SILENCE_HOURS，默认 72）；
 *  - 冷却：同项目 7 天内最多一张（push_log kind='PROJECT_REMINDER' 成功记录）；
 *  - 窗口：09:00–21:00 CST 之外跳过不补发（避免深夜打扰，同 scheduler 纪律）；
 *  - 幂等：pushCard 唯一键 (consultant, kind, run_id=proj:<pid>:<CST周键>)；FAILED 可重试。
 *  - 开关：BRAINX_PROJECT_REMINDER_OFF=1 关闭。
 */
import { now } from './db.js';
import { commitmentDetails } from './commitment.js';
import { pushCard } from './push.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { alignSoloAction } from './card-layout.js';

const REMINDER_KIND = 'PROJECT_REMINDER';
const COOLDOWN_MS = 7 * 86400000;

/** 最后操作时间（ISO 或 null）：项目维度的全部写路径都算「操作」。
 * 纯查询函数——测试可直接对内存库断言。 */
export function lastProjectActivityAt(db, projectId, chatId) {
  const latest = (rows) => rows.map((r) => r?.t).filter(Boolean).sort().pop() || null;
  return latest([
    chatId ? db.prepare('SELECT MAX(received_at) t FROM lark_messages WHERE chat_id=?').get(chatId) : null,
    db.prepare(`SELECT MAX(occurred_at) t FROM decision_events WHERE project_id=?`).get(projectId),
    db.prepare('SELECT MAX(observed_at) t FROM job_outcomes WHERE project_id=?').get(projectId),
    db.prepare(`SELECT MAX(t) t FROM (SELECT MAX(started_at) t FROM openmai_results WHERE project_id=?
      UNION ALL SELECT MAX(finished_at) FROM openmai_results WHERE project_id=?)`).get(projectId, projectId),
    db.prepare(`SELECT MAX(t) t FROM (SELECT MAX(created_at) t FROM commitment_actions WHERE project_id=?
      UNION ALL SELECT MAX(updated_at) FROM commitment_actions WHERE project_id=?)`).get(projectId, projectId),
    db.prepare('SELECT MAX(updated_at) t FROM project_launches WHERE project_id=?').get(projectId),
  ]);
}

/** CST 周键（冷却 run_id 组成部分）：同周同键，跨周自动放行。 */
export function reminderWeekKey(at = now()) {
  const cst = new Date(Date.parse(at) + 8 * 3600 * 1000);
  const day = cst.getUTCDay() || 7; // 周一=1…周日=7
  const monday = new Date(Date.UTC(cst.getUTCFullYear(), cst.getUTCMonth(), cst.getUTCDate() - day + 1));
  return monday.toISOString().slice(0, 10);
}

/** 是否处于发送窗口（09:00–21:00 CST）。纯函数；接受 Date 或 ISO 字符串。 */
export function inSendWindow(at = new Date()) {
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  const hour = new Date(ms + 8 * 3600 * 1000).getUTCHours();
  return hour >= 9 && hour < 21;
}

/** 筛选候选项目：静默超阈值 + 冷却外 + 承接进行中。返回卡片构建所需的全部上下文。 */
export function collectProjectReminders(db, at = now(), { silenceHours = 72 } = {}) {
  const launches = db.prepare(`SELECT l.launch_id, l.project_id, l.consultant_id, l.chat_id, l.chat_name,
      l.created_at AS launch_created_at, j.company, j.role
    FROM project_launches l
    LEFT JOIN job_facts j ON j.project_id=l.project_id
    WHERE l.status='READY' AND l.chat_id IS NOT NULL`).all();
  const stateStmt = db.prepare(`SELECT state FROM current_engagement
    WHERE project_id=? AND consultant_id=?`);
  const cutoff = new Date(Date.parse(at) - silenceHours * 3600000).toISOString();
  const cooldownCutoff = new Date(Date.parse(at) - COOLDOWN_MS).toISOString();
  const reminded = db.prepare(`SELECT 1 FROM push_log WHERE consultant_id=? AND kind='${REMINDER_KIND}'
    AND run_id LIKE ? AND status='SENT' AND created_at>=? LIMIT 1`);

  const out = [];
  for (const l of launches) {
    if (stateStmt.get(l.project_id, l.consultant_id)?.state !== 'ACCEPTED') continue;
    const lastAt = lastProjectActivityAt(db, l.project_id, l.chat_id) || l.launch_created_at;
    if (!lastAt || lastAt > cutoff) continue; // 静默不足
    if (reminded.get(l.consultant_id, `proj:${l.project_id}:%`, cooldownCutoff)) continue; // 冷却中
    const details = commitmentDetails(db, l.consultant_id, l.project_id);
    out.push({
      project_id: l.project_id, consultant_id: l.consultant_id, chat_id: l.chat_id,
      chat_name: l.chat_name || null, company: l.company || null, role: l.role || null,
      last_activity_at: lastAt, silent_hours: Math.round((Date.parse(at) - Date.parse(lastAt)) / 3600000),
      goal: details.commitment_goal, active_action: details.active_action,
      run_id: `proj:${l.project_id}:${reminderWeekKey(at)}`,
    });
  }
  return out;
}

/** 卡片（legacy v1 schema，同 push.js 纪律：按钮一律 URL 深链，修正走群内回复）。 */
export function buildProjectReminderCard(ctx, { publicBaseUrl } = {}) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const jobLine = [ctx.company, ctx.role].filter(Boolean).join(' · ') || ctx.project_id;
  const due = ctx.active_action?.due_at
    ? new Date(ctx.active_action.due_at).toISOString().slice(0, 10) : null;
  const actionLine = ctx.active_action
    ? `**当前行动**：${ctx.active_action.title}${due ? `（截止 ${due}）` : ''}`
    : '**当前行动**：没有进行中的行动——回复「下一步是…」即可建立';
  const els = [
    { tag: 'markdown', content:
      `这个项目已经 **${Math.max(1, Math.round(ctx.silent_hours / 24))} 天**（约 ${ctx.silent_hours} 小时）没有新进展了，回来对一下方向：\n`
      + `**本轮目标**：${ctx.goal || '（未记录——直接在群里回复补充）'}\n${actionLine}` },
    { tag: 'markdown', content:
      `_目标或时间节点不准？直接在群里回复修正（例：目标改为…；时间改为…），我会更新记录。_` },
    alignSoloAction({ tag: 'action', actions: [{
      tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开职位工作台' },
      multi_url: (() => { const u = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: ctx.project_id });
        return { url: u, pc_url: u, android_url: u, ios_url: u }; })(),
    }] }),
    { tag: 'note', elements: [{ tag: 'plain_text',
      content: `项目轻量提醒 · ${jobLine} · 回复「暂停」暂不打扰` }] },
  ];
  return { config: { wide_screen_mode: true },
    header: { template: 'turquoise', title: { tag: 'plain_text',
      content: `BrainTex · 项目要不要继续推？${now().slice(5, 16).replace('T', ' ')}` } },
    elements: els };
}

/** 一轮扫描。send=false 时只落 PREVIEW（不真发），供冒烟与测试。 */
export async function remindProjectsOnce(db, {
  at = now(), send = true, sendImpl = sendInteractiveCard, publicBaseUrl,
  silenceHours = Number(process.env.BRAINX_PROJECT_REMINDER_SILENCE_HOURS || 72),
} = {}) {
  if (!inSendWindow(at)) return { window: 'closed', candidates: 0, sent: 0, failed: 0 };
  const candidates = collectProjectReminders(db, at, { silenceHours });
  let sent = 0; let failed = 0;
  for (const ctx of candidates) {
    const card = buildProjectReminderCard(ctx, { publicBaseUrl });
    const out = await pushCard(db, {
      consultant_id: ctx.consultant_id, kind: REMINDER_KIND, run_id: ctx.run_id,
      card, target: ctx.chat_id, send, sendImpl,
    });
    if (out.status === 'SENT') sent += 1;
    else if (out.status === 'FAILED' || !out.ok) failed += 1;
    // PREVIEW / SKIPPED_DUPLICATE 不计入发送数（幂等重扫不虚报）
  }
  return { window: 'open', candidates: candidates.length, sent, failed };
}

export function startProjectReminderWorker(db, dependencies = {}) {
  if (process.env.BRAINX_PROJECT_REMINDER_OFF === '1') return { stop: () => {} };
  const intervalMs = Number(dependencies.intervalMs
    || process.env.BRAINX_PROJECT_REMINDER_INTERVAL_MS || 30 * 60 * 1000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await remindProjectsOnce(db, { ...dependencies, send: true });
      if (out.candidates) console.log(`[worker] 项目轻量提醒：候选 ${out.candidates}，发送 ${out.sent}，失败 ${out.failed}`);
    } catch (e) { console.error(`[worker] 项目轻量提醒异常: ${String(e?.message || e).slice(0, 120)}`); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
