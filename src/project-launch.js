/** 职位 → 飞书项目群：先落可恢复状态，再建群、投放职位并登记 Agent 群范围。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { createProjectChat, sendInteractiveCard } from './feishu-bot.js';
import { registerChatContext } from './gateway/chat-contexts.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { acceptCommitment } from './commitment.js';
import { currentState } from './engagement.js';
import { startOpenmaiTask } from './openmai-task.js';
import { ttcAuthStatus } from './ttcsdk/auth.js';
import { ensureOpenClawProjectGroup } from './openclaw-group-access.js';
import { retryOpenmaiDelivery } from './openmai-delivery.js';

const GROUP_PURPOSES = ['job_review', 'candidate_review', 'candidate_action', 'interview_prep'];

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
  return db.prepare(`SELECT tenant_id, channel_account_id, feishu_app_key_hash
    FROM feishu_identity_bindings
    WHERE consultant_id=? AND open_id=? AND binding_status='ACTIVE'
    ORDER BY updated_at DESC LIMIT 1`).get(consultantId, openId);
}

function findProjectCollaboratorOpenIds(db, projectId, binding, ownerOpenId) {
  const rows = db.prepare(`SELECT DISTINCT c.open_id
    FROM job_memberships m
    JOIN consultants c ON c.consultant_id=m.consultant_id AND c.active=1
    JOIN feishu_identity_bindings b
      ON b.consultant_id=c.consultant_id AND b.open_id=c.open_id AND b.binding_status='ACTIVE'
    WHERE m.project_id=? AND m.valid_to IS NULL AND m.relation IN ('MY_JOB','TEAM_SHARED')
      AND b.tenant_id=? AND b.channel_account_id=? AND b.feishu_app_key_hash=?
    ORDER BY c.open_id`).all(projectId, binding.tenant_id,
    binding.channel_account_id, binding.feishu_app_key_hash);
  return [...new Set([ownerOpenId, ...rows.map((row) => row.open_id)].filter(Boolean))];
}

export function projectLaunchPreflight(db, consultantId, projectId, {
  appConfigured, publicBaseUrl, requireSearch = false, ttcConnected,
} = {}) {
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
  const searchReady = ttcConnected ?? ttcAuthStatus(db, consultantId).connected;
  if (requireSearch && !searchReady) {
    blockers.push({ code: 'TTC_CREDENTIALS_REQUIRED', message: '请先用本人 TTC 账号连接 OpenMai' });
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

function activateGroup(db, { consultantId, projectId, chatId, openIds, binding }) {
  const at = now();
  registerChatContext(db, { chat_id: chatId, bot_mode: 'MENTION_ONLY', notes: `project:${projectId}` });
  const existing = db.prepare(`SELECT group_scope_id FROM agent_group_scopes
    WHERE channel_account_id=? AND chat_id=? AND scope_status='ACTIVE'`).get(binding.channel_account_id, chatId);
  if (existing) {
    db.prepare(`UPDATE agent_group_scopes SET tenant_id=?, allowed_purposes_json=?,
      allowed_senders_json=?, project_refs_json=?, require_mention=1, updated_at=?
      WHERE group_scope_id=?`).run(binding.tenant_id, JSON.stringify(GROUP_PURPOSES),
      JSON.stringify(openIds), JSON.stringify([projectId]), at, existing.group_scope_id);
  } else {
    db.prepare(`INSERT INTO agent_group_scopes
      (group_scope_id, tenant_id, channel_account_id, chat_id, scope_status,
       allowed_purposes_json, allowed_senders_json, project_refs_json, require_mention, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?, ?, 1, ?, ?)`).run(
      randomUUID(), binding.tenant_id, binding.channel_account_id, chatId,
      JSON.stringify(GROUP_PURPOSES), JSON.stringify(openIds), JSON.stringify([projectId]), at, at,
    );
  }
}

export function getProjectLaunch(db, consultantId, projectId) {
  return db.prepare(`SELECT launch_id, project_id, status, current_step, chat_id, chat_name,
    message_id, search_status, search_task_id, search_started_at,
    error_code, error_message, created_at, updated_at
    FROM project_launches WHERE consultant_id=? AND project_id=?`).get(consultantId, projectId) || null;
}

function workflowDueAt() {
  const value = new Date(Date.now() + 2 * 86400000);
  value.setHours(18, 0, 0, 0);
  return value.toISOString();
}

/** 一次明确确认完成：项目群 → 接单行动 → OpenMai。 */
export async function launchRecruitingWorkflow(db, bus, consultantId, projectId, input = {}, dependencies = {}) {
  if (input.confirm !== true) fail(422, 'CONFIRM_REQUIRED', '启动飞书寻访需要本次明确确认');
  const preflight = projectLaunchPreflight(db, consultantId, projectId, {
    appConfigured: dependencies.appConfigured,
    publicBaseUrl: dependencies.publicBaseUrl,
    requireSearch: true,
    ttcConnected: dependencies.ttcConnected,
  });
  if (!preflight.ready) {
    const first = preflight.blockers[0];
    fail(409, first.code, first.message);
  }
  const group = await launchProject(db, consultantId, projectId, input, dependencies);
  const launchId = group.launch.launch_id;
  const state = currentState(db, consultantId, projectId).state;
  if (['COMPLETED', 'RELEASED'].includes(state)) {
    fail(409, 'PROJECT_NOT_ACTIVE', '该项目当前状态不能启动寻访');
  }
  if (state !== 'ACCEPTED') {
    const accepted = acceptCommitment(db, consultantId, projectId, {
      goal: '完成首轮候选人搜索与匹配评估',
      action_title: '查看首轮候选人并决定联系或继续搜索',
      due_at: workflowDueAt(),
      idempotency_key: `project-launch:${launchId}:accept`,
    });
    if (!accepted.ok) fail(accepted.status || 409, 'PROJECT_ACCEPT_FAILED', accepted.error);
  }
  if (group.launch.search_status === 'FAILED'
      && group.launch.error_code === 'FEISHU_OPENMAI_DELIVERY_FAILED') {
    const retryDelivery = dependencies.retryOpenmaiDelivery || retryOpenmaiDelivery;
    const search = retryDelivery(db, consultantId, projectId);
    if (search) {
      db.prepare(`UPDATE project_launches SET search_status='RUNNING',error_code=NULL,error_message=NULL,
        updated_at=? WHERE consultant_id=? AND project_id=?`).run(now(), consultantId, projectId);
      return { ok: true, group: group.launch, search,
        launch: getProjectLaunch(db, consultantId, projectId) };
    }
  }
  const startSearch = dependencies.startOpenmaiTask || startOpenmaiTask;
  const retryIncomplete = group.launch.search_status === 'FAILED'
    && group.launch.error_code === 'OPENMAI_CANDIDATES_INCOMPLETE';
  const search = startSearch(db, bus, consultantId, projectId, { force: retryIncomplete });
  const status = search.status === 'error' ? 'FAILED'
    : search.status === 'already_done' ? 'DONE' : 'RUNNING';
  db.prepare(`UPDATE project_launches SET search_status=?, search_task_id=?, search_started_at=?,
    error_code=CASE WHEN ?='FAILED' THEN 'OPENMAI_START_FAILED' ELSE NULL END,
    error_message=CASE WHEN ?='FAILED' THEN ? ELSE NULL END, updated_at=?
    WHERE consultant_id=? AND project_id=?`).run(
    status, search.task_id || null, search.started_at || now(), status, status,
    status === 'FAILED' ? safeError(search.message) : null, now(), consultantId, projectId,
  );
  if (status === 'FAILED') fail(502, 'OPENMAI_START_FAILED', search.message || 'OpenMai 启动失败');
  return { ok: true, group: group.launch, search, launch: getProjectLaunch(db, consultantId, projectId) };
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
  const allowOpenClawGroup = dependencies.ensureOpenClawGroupAllowed || ensureOpenClawProjectGroup;
  const collaboratorOpenIds = findProjectCollaboratorOpenIds(
    db, projectId, preflight.binding, preflight.job.consultant_open_id,
  );
  let chatId = launch.chat_id;
  try {
    if (!chatId) {
      const created = await createChat({
        name: `${preflight.job.company}-${preflight.job.role}`,
        description: `BrainTex 职位项目 ${projectId}`,
        ownerOpenId: preflight.job.consultant_open_id,
        memberOpenIds: collaboratorOpenIds,
        idempotencyKey: launch.launch_id,
      });
      chatId = created.chat_id;
      db.prepare(`UPDATE project_launches SET status='POSTING_JOB', current_step='POST_JOB',
        chat_id=?, chat_name=?, error_code=NULL, error_message=NULL, updated_at=?
        WHERE consultant_id=? AND project_id=?`).run(
        chatId, created.name, now(), consultantId, projectId,
      );
    }
    await allowOpenClawGroup(chatId, collaboratorOpenIds);
    const sent = await sendCard({
      target: chatId,
      card: buildProjectLaunchCard(preflight.job, { publicBaseUrl: dependencies.publicBaseUrl }),
      idempotencyKey: `${launch.launch_id}-job`,
    });
    db.exec('BEGIN');
    try {
      activateGroup(db, { consultantId, projectId, chatId,
        openIds: collaboratorOpenIds, binding: preflight.binding });
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
    fail(502, code, chatId
      ? '项目群已创建，但机器人群准入、职位投放或本地登记失败；请重试'
      : '飞书项目群创建失败；请重试');
  }
}
