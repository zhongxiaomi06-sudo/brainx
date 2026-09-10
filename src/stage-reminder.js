/** stage-reminder.js — 每日分阶段推进提醒（specs/010，2026-09-10）。
 *
 * 顾问个人的每日私聊提醒链（与 specs/009 群内静默唤醒互补）：
 *  - A 没接单        → 「今天想看什么岗位吗？」（每人每天 1 张）
 *  - B 接单未找人    → 「现在想找人吗？」（ACCEPTED 但 openmai_results 无行；按项目逐条）
 *  - C 找人未推进    → 「要找新的人吗？」（有找人结果但无 job_outcomes/建群；按项目逐条）
 *
 * 规则（specs/010）：
 *  - 时间：CST 工作日，到达 BRAINX_STAGE_REMINDER_AT（默认 12:30）后首个周期发送，
 *    21:00 后不发（窗口内补发覆盖 worker 重启/停机）；日键幂等保证每天最多一张；
 *  - 静默：项目最后操作（复用 009 lastProjectActivityAt）距今 > 24h
 *    （BRAINX_STAGE_REMINDER_SILENCE_HOURS）才提醒，刚接单/刚找人的项目不打扰；
 *  - 偏好：consultants.profile_json.push_preferences.enabled=false 全阶段跳过；
 *  - 幂等：push_log(kind='STAGE_REMINDER', run_id='stage:<phase>:<project_id|->:<日键>')；
 *  - 开关：BRAINX_STAGE_REMINDER_OFF=1 关闭。
 */
import { now } from './db.js';
import { pushCard } from './push.js';
import { getPushPreferences } from './push-preferences.js';
import { sendInteractiveCard } from './feishu-bot.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { lastProjectActivityAt } from './project-reminder.js';

const REMINDER_KIND = 'STAGE_REMINDER';

/** CST 日键（YYYY-MM-DD）：幂等 run_id 组成部分，跨天自动放行。 */
export function stageDayKey(at = now()) {
  return new Date(Date.parse(at) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** CST 星期：0=周日 6=周六。 */
function cstWeekday(at = now()) {
  return new Date(Date.parse(at) + 8 * 3600 * 1000).getUTCDay();
}

/** CST 当天分钟数（0-1439）。 */
export function cstMinutesCst(at = now()) {
  const cst = new Date(Date.parse(at) + 8 * 3600 * 1000);
  return cst.getUTCHours() * 60 + cst.getUTCMinutes();
}

function parseRemindAt(remindAt) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(remindAt || '').trim());
  if (!m) throw new Error(`STAGE_REMINDER_AT 格式应为 HH:mm，收到 ${remindAt}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 发送门：CST 工作日 且 [remindAt, 21:00) 窗口内。纯函数。 */
export function inStageSendWindow(at = now(), remindAt = '12:30') {
  const wd = cstWeekday(at);
  if (wd === 0 || wd === 6) return false; // 周末不发
  const minutes = cstMinutesCst(at);
  return minutes >= parseRemindAt(remindAt) && minutes < 21 * 60;
}

/** A 阶段候选：活跃顾问 + 有 open_id + 无任何 ACCEPTED 承接 + 偏好开启。 */
function collectStageA(db) {
  return db.prepare(`SELECT c.consultant_id, c.open_id, c.display_name
    FROM consultants c
    WHERE c.active=1 AND c.open_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM current_engagement ce
        WHERE ce.consultant_id=c.consultant_id AND ce.state='ACCEPTED')`).all()
    .filter((c) => getPushPreferences(db, c.consultant_id)?.enabled !== false)
    .map((c) => ({ phase: 'A', consultant_id: c.consultant_id, open_id: c.open_id,
      display_name: c.display_name, project_id: null, company: null, role: null }));
}

/** B/C 阶段候选：ACCEPTED 项目 × 找人状态 × 推进信号。 */
function collectStageBC(db, at, silenceMs, silenceHours) {
  const rows = db.prepare(`SELECT ce.project_id, ce.consultant_id, ce.state_since, c.open_id,
      c.display_name, j.company, j.role
    FROM current_engagement ce
    JOIN consultants c ON c.consultant_id=ce.consultant_id AND c.active=1 AND c.open_id IS NOT NULL
    LEFT JOIN job_facts j ON j.project_id=ce.project_id
    WHERE ce.state='ACCEPTED'`).all();
  const searchExists = db.prepare('SELECT 1 FROM openmai_results WHERE project_id=? LIMIT 1');
  const outcomeExists = db.prepare('SELECT 1 FROM job_outcomes WHERE project_id=? LIMIT 1');
  const groupExists = db.prepare('SELECT 1 FROM candidate_decision_groups WHERE position_id=? LIMIT 1');
  const out = [];
  for (const r of rows) {
    if (getPushPreferences(db, r.consultant_id)?.enabled === false) continue;
    const hasSearch = !!searchExists.get(r.project_id);
    if (!hasSearch) {
      // B：接单未找人，且接单时间已超静默阈值（刚接单不打扰）
      if (r.state_since && Date.parse(at) - Date.parse(r.state_since) <= silenceMs) continue;
      out.push({ phase: 'B', ...r });
      continue;
    }
    // C：找人了但没有任何推进信号（无结果记录、未建决策群），且项目静默超阈值
    if (outcomeExists.get(r.project_id) || groupExists.get(r.project_id)) continue;
    const lastAt = lastProjectActivityAt(db, r.project_id, null) || r.state_since;
    if (!lastAt || Date.parse(at) - Date.parse(lastAt) <= silenceMs) continue;
    out.push({ phase: 'C', ...r });
  }
  return out.map((x) => ({ ...x, silent_hours: silenceHours }));
}

/** 三阶段扫描。返回卡片上下文数组（含幂等 run_id）。 */
export function collectStageReminders(db, at = now(), { silenceHours = 24 } = {}) {
  const silenceMs = silenceHours * 3600000;
  const day = stageDayKey(at);
  const a = collectStageA(db).map((x) => ({ ...x, run_id: `stage:A:-:${day}` }));
  const bc = collectStageBC(db, at, silenceMs, silenceHours)
    .map((x) => ({ ...x, run_id: `stage:${x.phase}:${x.project_id}:${day}` }));
  return [...a, ...bc];
}

/** 卡片（legacy v1 schema，同 push.js 纪律：按钮一律 URL 深链，动作在工作台/私聊对话完成）。 */
export function buildStageReminderCard(ctx, { publicBaseUrl } = {}) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const jobLine = [ctx.company, ctx.role].filter(Boolean).join(' · ');
  const jobBtn = (text) => ({ tag: 'action', actions: [{
    tag: 'button', type: 'primary', text: { tag: 'plain_text', content: text },
    multi_url: (() => { const u = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity',
      objectRef: ctx.project_id }); return { url: u, pc_url: u, android_url: u, ios_url: u }; })(),
  }] });
  const note = { tag: 'note', elements: [{ tag: 'plain_text',
    content: `每日推进提醒 · ${jobLine || ctx.display_name || ctx.consultant_id} · 可在推送偏好里调整或关闭` }] };

  if (ctx.phase === 'A') {
    return { config: { wide_screen_mode: true },
      header: { template: 'turquoise', title: { tag: 'plain_text', content: 'BrainTex · 今天想看什么岗位吗？' } },
      elements: [
        { tag: 'markdown', content: `**${ctx.display_name || ctx.consultant_id}**，你目前没有进行中的接单。\n直接私聊我你想找的岗位方向（如「找 3 年内的增长投放」），我按判据去搜人；或先看看今天建议优先处理的职位。` },
        { tag: 'action', actions: [{ tag: 'button', type: 'primary',
          text: { tag: 'plain_text', content: '打开工作台看职位' },
          multi_url: (() => { const u = baseUrl; return { url: u, pc_url: u, android_url: u, ios_url: u }; })() }] },
        note,
      ] };
  }
  if (ctx.phase === 'B') {
    return { config: { wide_screen_mode: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: 'BrainTex · 现在想找人吗？' } },
      elements: [
        { tag: 'markdown', content: `**${jobLine || ctx.project_id}** 已接单，但**还没有启动找人**。\n打开职位确认信息后一键启动，或直接私聊我补充要找的人选画像。` },
        jobBtn('打开职位 · 启动找人'),
        note,
      ] };
  }
  return { config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: 'BrainTex · 要找新的人吗？' } },
    elements: [
      { tag: 'markdown', content: `**${jobLine || ctx.project_id}** 的找人结果已经回来，但**还没有推进记录**（没有标记重点候选人、没有结果记录、也没建决策群）。\n上去处理本轮结果，或告诉我这轮不合适、重新按新判据找一批。` },
      jobBtn('打开职位 · 处理结果'),
      note,
    ] };
}

/** 一轮扫描。send=false 只落 PREVIEW（不真发），供冒烟与测试。 */
export async function remindStagesOnce(db, {
  at = now(), send = true, sendImpl = sendInteractiveCard, publicBaseUrl,
  silenceHours = Number(process.env.BRAINX_STAGE_REMINDER_SILENCE_HOURS || 24),
  remindAt = process.env.BRAINX_STAGE_REMINDER_AT || '12:30',
} = {}) {
  if (!inStageSendWindow(at, remindAt)) return { window: 'closed', candidates: 0, sent: 0, failed: 0 };
  const candidates = collectStageReminders(db, at, { silenceHours });
  let sent = 0; let failed = 0;
  for (const ctx of candidates) {
    const card = buildStageReminderCard(ctx, { publicBaseUrl });
    const out = await pushCard(db, {
      consultant_id: ctx.consultant_id, kind: REMINDER_KIND, run_id: ctx.run_id,
      card, target: ctx.open_id, send, sendImpl,
    });
    if (out.status === 'SENT') sent += 1;
    else if (out.status === 'FAILED' || !out.ok) failed += 1;
    // PREVIEW / SKIPPED_DUPLICATE 不计入发送数（幂等重扫不虚报）
  }
  return { window: 'open', candidates: candidates.length, sent, failed };
}

export function startStageReminderWorker(db, dependencies = {}) {
  if (process.env.BRAINX_STAGE_REMINDER_OFF === '1') return { stop: () => {} };
  const intervalMs = Number(dependencies.intervalMs
    || process.env.BRAINX_STAGE_REMINDER_INTERVAL_MS || 15 * 60 * 1000);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const out = await remindStagesOnce(db, { ...dependencies, send: true });
      if (out.candidates) console.log(`[worker] 每日阶段提醒：候选 ${out.candidates}，发送 ${out.sent}，失败 ${out.failed}`);
    } catch (e) { console.error(`[worker] 每日阶段提醒异常: ${String(e?.message || e).slice(0, 120)}`); }
    finally { running = false; }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
