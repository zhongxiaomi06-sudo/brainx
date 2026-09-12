/** group-intake.js — 机器人进旧群的入群接管（specs/015）。
 *
 * 入群感知靠轮询 GET /open-apis/im/v1/chats（既有约束：不开第二条长连接、
 * openclaw 插件对 im.chat.member.bot.added_v1 只记日志）。首轮只做基线不发卡，
 * 避免上线即轰炸历史群（含死群）。新群发「绑定职位」卡；顾问在群里绑定后
 * 激活群范围、发找人卡，并私聊发拉群指引 + 防滥用提醒。
 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { listBotChats, sendInteractiveCard } from './feishu-bot.js';
import { registerChatContext, getChatContext } from './gateway/chat-contexts.js';
import { ensureOpenClawProjectGroup } from './openclaw-group-access.js';
import { ensureAccessWithStatus } from './openclaw-group-status.js';
import {
  projectLaunchPreflight, activateGroup, findProjectCollaboratorOpenIds, buildProjectLaunchCard,
} from './project-launch.js';
import { currentState } from './engagement.js';
import { jobVisibleTo } from './visibility.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { alignSoloAction } from './card-layout.js';

const BINDING_PURPOSES = ['group_binding'];
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

export function listKnownChatIds(db) {
  return new Set(db.prepare('SELECT chat_id FROM bot_chat_intake').all().map((row) => row.chat_id));
}

function intakeRow(db, chatId) {
  return db.prepare('SELECT status, project_id FROM bot_chat_intake WHERE chat_id=?').get(chatId);
}

/** 顾问名下可绑定到本群的职位（specs/015 bind 工具 list 模式用）。 */
export function listBindableJobs(db, consultantId) {
  const rows = db.prepare(`SELECT j.project_id, j.company, j.role, j.city, j.pipeline, j.hc, j.active_state
    FROM job_facts j
    JOIN job_memberships m ON m.project_id=j.project_id AND m.consultant_id=? AND m.valid_to IS NULL
      AND m.relation IN ('MY_JOB','TEAM_SHARED')
    WHERE j.active_state='OPEN'
    ORDER BY j.captured_at DESC LIMIT 20`).all(consultantId);
  return rows.filter((row) => jobVisibleTo(db, consultantId, row.project_id))
    .map((row) => ({ project_id: row.project_id, company: row.company, role: row.role,
      city: row.city || null, pipeline: row.pipeline || null, hc: Number.isInteger(row.hc) ? row.hc : null }));
}

export function buildBindCard({ chatName, publicBaseUrl }) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const detailUrl = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: 'mine' });
  const command = '为当前群绑定一个职位。先调用 brainx_bind_group_project（不带 job_id）列出顾问名下可绑定职位，'
    + '把清单呈现给顾问让他选；顾问选定后，用该 job_id 与 confirm=true 再次调用 brainx_bind_group_project 完成绑定。'
    + '不要询问群号或职位编号，也不要假设职位。';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'BrainTex 项目群绑定' } },
    elements: [
      { tag: 'markdown', content: `**我是 BrainTex 机器人**\n这个群（${String(chatName || '').slice(0, 60) || '未命名群'}）还没绑定职位，暂时无法在这里找人。` },
      { tag: 'markdown', content: '点下方按钮，从你名下的职位里选一个绑定到本群；绑定后即可在群里点按钮找人。\n也可以直接把 JD 粘贴到本群，我会帮你建岗。' },
      { tag: 'action', actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '绑定我的职位' },
          value: { text: command } },
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '打开工作台' },
          multi_url: { url: detailUrl, pc_url: detailUrl, android_url: detailUrl, ios_url: detailUrl } },
      ] },
    ],
  };
}

export function buildGuidanceCard({ chatName, job, consultantName, publicBaseUrl }) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const detailUrl = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: 'mine' });
  const bound = job ? `${job.company}·${job.role}` : '已绑定职位';
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: 'BrainTex 拉群使用指引' } },
    elements: [
      { tag: 'markdown', content: `${consultantName ? `**${consultantName}**，` : ''}你已把群「${String(chatName || '').slice(0, 60) || '未命名群'}」绑定到 ${bound}，现在可以在群里点按钮找人了。` },
      { tag: 'markdown', content: '**如何拉群**\n在飞书任意群 → 群设置 → 群机器人 → 添加应用 → 选「BrainTex」。机器人进群后会自动弹「绑定职位」卡，选职位即可开始找人。' },
      { tag: 'markdown', content: '**不要拉太多群**\n每个群机器人都会处理消息、按职位找人，群太多会让消息过载、token 成本飙升。**只给当前在做的职位建群**，做完的群可移除机器人。' },
      // F4：这张卡只有一个动作，右对齐收口。
      alignSoloAction({ tag: 'action', actions: [
        { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '打开工作台' },
          multi_url: { url: detailUrl, pc_url: detailUrl, android_url: detailUrl, ios_url: detailUrl } },
      ] }),
    ],
  };
}

async function intakeNewChat(db, { chat_id, name }, deps) {
  const ctx = getChatContext(db, chat_id);
  if (ctx && ctx.enabled === 0) {
    markIntake(db, chat_id, name, 'SKIPPED');
    return;
  }
  markIntake(db, chat_id, name, 'SEEN');
  registerChatContext(db, { chat_id, bot_mode: 'MENTION_ONLY', notes: 'intake:pending' });
  // openclaw 白名单 best-effort：senders 空（顾问已在全局 groupSenderAllowFrom）。
  await ensureAccessWithStatus(deps.ensureOpenClawGroup || ensureOpenClawProjectGroup, chat_id, []);
  const card = buildBindCard({ chatName: name, publicBaseUrl: deps.publicBaseUrl });
  await deps.sendCard({ target: chat_id, card,
    idempotencyKey: `intake-bind-card:${chat_id}` });
  db.prepare(`UPDATE bot_chat_intake SET status='CARD_SENT', card_sent_at=?, updated_at=? WHERE chat_id=?`)
    .run(now(), now(), chat_id);
}

function markIntake(db, chatId, name, status) {
  const at = now();
  db.prepare(`INSERT INTO bot_chat_intake (chat_id, chat_name, status, first_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET chat_name=excluded.chat_name, status=excluded.status, updated_at=excluded.updated_at`)
    .run(chatId, name || null, status, at, at);
}

export async function runGroupIntakeOnce(db, deps = {}) {
  const sendCard = deps.sendCard || (async (input) => sendInteractiveCard({
    target: input.target, card: input.card, idempotencyKey: input.idempotencyKey,
  }));
  const listChats = deps.listChats || ((opts) => listBotChats({ ...opts, fetchImpl: deps.fetchImpl }));
  const known = listKnownChatIds(db);
  const baseline = known.size === 0;
  const chats = await listChats();
  for (const chat of chats) {
    if (known.has(chat.chat_id)) continue;
    if (baseline) {
      const ctx = getChatContext(db, chat.chat_id);
      markIntake(db, chat.chat_id, chat.name, ctx && ctx.enabled === 0 ? 'SKIPPED' : 'SEEN');
      continue;
    }
    try {
      await intakeNewChat(db, chat, { ...deps, sendCard });
    } catch (error) {
      // 单群失败不阻断其它群；下一轮会重试（仍 SEEN）
      db.prepare(`UPDATE bot_chat_intake SET chat_name=?, updated_at=? WHERE chat_id=?`)
        .run(chat.name || null, now(), chat.chat_id);
    }
  }
  return { baseline, scanned: chats.length };
}

export function startGroupIntakeWorker(db, opts = {}) {
  if (process.env.BRAINX_GROUP_INTAKE_OFF === '1') return null;
  const intervalMs = opts.intervalMs || Number(process.env.BRAINX_GROUP_INTAKE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const tick = async () => {
    try { await runGroupIntakeOnce(db, opts); }
    catch { /* 轮询整体失败静默，下一轮再来 */ }
  };
  const timer = setInterval(tick, intervalMs);
  tick().catch(() => {});
  return () => clearInterval(timer);
}

/**
 * 把一个旧群绑定到职位（specs/015 bind 工具调用）。前置：chat 已在 bot_chat_intake 且
 * 未 BOUND（由 authorization 的 allowIntakeBinding 卡口保证）；顾问对职位可见。
 * 激活群范围 → 回填 job_facts.chat_id → 群里发找人卡 → 私聊发拉群指引。发卡 best-effort。
 */
export async function bindGroupToProject(db, { consultantId, projectId, chatId, publicBaseUrl, sendCardFn }) {
  const intake = intakeRow(db, chatId);
  if (!intake) throw Object.assign(new Error('GROUP_NOT_INTAKED'), { code: 'GROUP_NOT_INTAKED' });
  if (intake.status === 'BOUND') throw Object.assign(new Error('GROUP_ALREADY_BOUND'), { code: 'GROUP_ALREADY_BOUND' });
  const preflight = projectLaunchPreflight(db, consultantId, projectId, { appConfigured: true, publicBaseUrl });
  if (!preflight.ready) {
    const first = preflight.blockers[0];
    throw Object.assign(new Error(first.code || 'BIND_BLOCKED'), { code: first.code || 'BIND_BLOCKED' });
  }
  const { job, binding } = preflight;
  const openIds = findProjectCollaboratorOpenIds(db, projectId, binding, job.consultant_open_id);
  const at = now();
  db.exec('BEGIN');
  try {
    activateGroup(db, { consultantId, projectId, chatId, openIds, binding });
    db.prepare('UPDATE job_facts SET chat_id=?, updated_at=? WHERE project_id=?').run(chatId, at, projectId);
    db.prepare(`UPDATE bot_chat_intake SET status='BOUND', project_id=?, updated_at=? WHERE chat_id=?`)
      .run(projectId, at, chatId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  const state = currentState(db, consultantId, projectId).state;
  const sendCard = sendCardFn || (async (input) => sendInteractiveCard({
    target: input.target, card: input.card, idempotencyKey: input.idempotencyKey,
  }));
  const chatName = db.prepare('SELECT chat_name FROM bot_chat_intake WHERE chat_id=?').get(chatId)?.chat_name || null;
  const consultantName = db.prepare('SELECT display_name FROM consultants WHERE consultant_id=?').get(consultantId)?.display_name || null;
  // 群里发找人卡（按当前承接状态，未接单给接单按钮）；顾问私聊发拉群指引 + 防滥用提醒。
  Promise.all([
    sendCard({ target: chatId,
      card: buildProjectLaunchCard(job, { publicBaseUrl, state }),
      idempotencyKey: `intake-launch-card:${projectId}:${chatId}` }).catch(() => {}),
    sendCard({ target: job.consultant_open_id,
      card: buildGuidanceCard({ chatName, job, consultantName, publicBaseUrl }),
      idempotencyKey: `intake-guidance:${consultantId}:${chatId}` }).catch(() => {}),
  ]).catch(() => {});
  return { ok: true, project_id: projectId, chat_id: chatId, state };
}
