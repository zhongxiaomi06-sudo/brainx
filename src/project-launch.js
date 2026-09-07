/** 职位 → 飞书项目群：先落可恢复状态，再建群、投放职位并登记 Agent 群范围。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { createProjectChat, sendInteractiveCard } from './feishu-bot.js';
import { registerChatContext } from './gateway/chat-contexts.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';

const GROUP_PURPOSES = ['job_review', 'candidate_review', 'interview_prep'];

export class ProjectLaunchError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ProjectLaunchError';
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new ProjectLaunchError(status, code, message); };
const safeError = (error) => String(error?.message || error || '未知错误').slice(0, 240);

function findBinding(db, consultantId, openId) {
  return db.prepare(`SELECT tenant_id, channel_account_id
    FROM feishu_identity_bindings
    WHERE consultant_id=? AND open_id=? AND binding_status='ACTIVE'
    ORDER BY updated_at DESC LIMIT 1`).get(consultantId, openId);
}

export function projectLaunchPreflight(db, consultantId, projectId, { appConfigured, publicBaseUrl } = {}) {
  const job = db.prepare(`SELECT j.*, c.display_name AS consultant_name, c.open_id AS consultant_open_id
    FROM job_facts j JOIN consultants c ON c.consultant_id=? AND c.active=1
    WHERE j.project_id=?`).get(consultantId, projectId);
  if (!job) fail(404, 'NOT_FOUND', '职位不存在');
  const membership = db.prepare(`SELECT relation FROM job_memberships
    WHERE consultant_id=? AND project_id=? AND valid_to IS NULL
      AND relation IN ('MY_JOB','TEAM_SHARED') ORDER BY id DESC LIMIT 1`).get(consultantId, projectId);
  const blockers = [];
  if (!membership) blockers.push({ code: 'PROJECT_MEMBERSHIP_REQUIRED', message: '请先加入我的项目' });
  if (!job.consultant_open_id) blockers.push({ code: 'FEISHU_IDENTITY_REQUIRED', message: '顾问尚未绑定飞书 open_id' });
  const binding = job.consultant_open_id ? findBinding(db, consultantId, job.consultant_open_id) : null;
  if (job.consultant_open_id && !binding) {
    blockers.push({ code: 'AGENT_IDENTITY_BINDING_REQUIRED', message: '顾问尚未完成 Agent 身份绑定' });
  }
  const configured = appConfigured ?? Boolean(
    (process.env.BRAINX_FEISHU_APP_ID || process.env.LARK_APP_ID)
    && (process.env.BRAINX_FEISHU_APP_SECRET || process.env.LARK_APP_SECRET),
  );
  if (!configured) blockers.push({ code: 'FEISHU_BOT_CREDENTIALS_MISSING', message: '飞书应用凭证未配置' });
  try { productionBaseUrl(publicBaseUrl); } catch {
    blockers.push({ code: 'BRAINX_BASE_URL_REQUIRED', message: 'BrainTex 生产 HTTPS 地址未配置' });
  }
  return { ready: blockers.length === 0, blockers, job, membership: membership?.relation || null, binding };
}

export function buildProjectLaunchCard(job, { publicBaseUrl } = {}) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const detailUrl = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: job.project_id });
  const facts = [job.city, job.hc == null ? null : `HC ${job.hc}`, job.pipeline].filter(Boolean).join(' · ');
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `BrainTex 项目 · ${job.company}` } },
    elements: [
      { tag: 'markdown', content: `**${job.role}**\n${facts || '职位基础信息待补充'}\n\n`
        + `项目编号：${job.project_id}\n负责人：${job.consultant_name}` },
      { tag: 'markdown', content: '**机器人已进入项目群**\n正在准备启动候选人搜索；后续候选人、简历和匹配评估会在本群更新。' },
      { tag: 'action', actions: [{
        tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '打开职位工作台' },
        multi_url: { url: detailUrl, pc_url: detailUrl, android_url: detailUrl, ios_url: detailUrl },
      }] },
    ],
  };
}

function saveFailure(db, consultantId, projectId, code, message) {
  db.prepare(`UPDATE project_launches SET status='FAILED', error_code=?, error_message=?, updated_at=?
    WHERE consultant_id=? AND project_id=?`).run(code, message, now(), consultantId, projectId);
}

function activateGroup(db, { consultantId, projectId, chatId, openId, binding }) {
  const at = now();
  registerChatContext(db, { chat_id: chatId, bot_mode: 'MENTION_ONLY', notes: `project:${projectId}` });
  const existing = db.prepare(`SELECT group_scope_id FROM agent_group_scopes
    WHERE channel_account_id=? AND chat_id=? AND scope_status='ACTIVE'`).get(binding.channel_account_id, chatId);
  if (existing) {
    db.prepare(`UPDATE agent_group_scopes SET tenant_id=?, allowed_purposes_json=?,
      allowed_senders_json=?, project_refs_json=?, require_mention=1, updated_at=?
      WHERE group_scope_id=?`).run(binding.tenant_id, JSON.stringify(GROUP_PURPOSES),
      JSON.stringify([openId]), JSON.stringify([projectId]), at, existing.group_scope_id);
  } else {
    db.prepare(`INSERT INTO agent_group_scopes
      (group_scope_id, tenant_id, channel_account_id, chat_id, scope_status,
       allowed_purposes_json, allowed_senders_json, project_refs_json, require_mention, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 1, ?, ?)`).run(
      randomUUID(), binding.tenant_id, binding.channel_account_id, chatId,
      JSON.stringify(GROUP_PURPOSES), JSON.stringify([openId]), JSON.stringify([projectId]), at, at,
    );
  }
}

export function getProjectLaunch(db, consultantId, projectId) {
  return db.prepare(`SELECT launch_id, project_id, status, current_step, chat_id, chat_name,
    message_id, error_code, error_message, created_at, updated_at
    FROM project_launches WHERE consultant_id=? AND project_id=?`).get(consultantId, projectId) || null;
}

export async function launchProject(db, consultantId, projectId, input = {}, dependencies = {}) {
  const idempotencyKey = String(input.idempotency_key || '').trim();
  if (!idempotencyKey || idempotencyKey.length > 200) {
    fail(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少有效的 idempotency_key');
  }
  const preflight = projectLaunchPreflight(db, consultantId, projectId, {
    appConfigured: dependencies.appConfigured,
    publicBaseUrl: dependencies.publicBaseUrl,
  });
  if (!preflight.ready) {
    const first = preflight.blockers[0];
    fail(409, first.code, first.message);
  }
  let launch = getProjectLaunch(db, consultantId, projectId);
  if (launch?.status === 'READY') return { ok: true, already: true, launch };
  if (!launch) {
    const at = now();
    db.prepare(`INSERT INTO project_launches
      (launch_id, consultant_id, project_id, idempotency_key, status, current_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'CREATING_CHAT', 'CREATE_CHAT', ?, ?)`).run(
      randomUUID(), consultantId, projectId, idempotencyKey, at, at,
    );
    launch = getProjectLaunch(db, consultantId, projectId);
  }

  const createChat = dependencies.createProjectChat || createProjectChat;
  const sendCard = dependencies.sendInteractiveCard || sendInteractiveCard;
  let chatId = launch.chat_id;
  try {
    if (!chatId) {
      const created = await createChat({
        name: `${preflight.job.company}-${preflight.job.role}`,
        description: `BrainTex 职位项目 ${projectId}`,
        ownerOpenId: preflight.job.consultant_open_id,
        idempotencyKey: launch.launch_id,
      });
      chatId = created.chat_id;
      db.prepare(`UPDATE project_launches SET status='POSTING_JOB', current_step='POST_JOB',
        chat_id=?, chat_name=?, error_code=NULL, error_message=NULL, updated_at=?
        WHERE consultant_id=? AND project_id=?`).run(
        chatId, created.name, now(), consultantId, projectId,
      );
    }
    const sent = await sendCard({
      target: chatId,
      card: buildProjectLaunchCard(preflight.job, { publicBaseUrl: dependencies.publicBaseUrl }),
      idempotencyKey: `${launch.launch_id}-job`,
    });
    db.exec('BEGIN');
    try {
      activateGroup(db, { consultantId, projectId, chatId,
        openId: preflight.job.consultant_open_id, binding: preflight.binding });
      db.prepare('UPDATE job_facts SET chat_id=?, updated_at=? WHERE project_id=?')
        .run(chatId, now(), projectId);
      db.prepare(`UPDATE project_launches SET status='READY', current_step='READY', message_id=?,
        error_code=NULL, error_message=NULL, updated_at=? WHERE consultant_id=? AND project_id=?`).run(
        sent.message_id || null, now(), consultantId, projectId,
      );
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ok: true, already: false, launch: getProjectLaunch(db, consultantId, projectId) };
  } catch (error) {
    const code = error.code || (chatId ? 'FEISHU_JOB_POST_FAILED' : 'FEISHU_CHAT_CREATE_FAILED');
    saveFailure(db, consultantId, projectId, code, safeError(error));
    fail(502, code, chatId ? '项目群已创建，但职位投放或本地登记失败；请重试' : '飞书项目群创建失败；请重试');
  }
}
