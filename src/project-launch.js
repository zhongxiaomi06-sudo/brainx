/** 职位 → 飞书项目群：先落可恢复状态，再建群、投放职位并登记 Agent 群范围。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { createProjectChat, sendInteractiveCard } from './feishu-bot.js';
import { registerChatContext } from './gateway/chat-contexts.js';
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { acceptCommitment } from './commitment.js';
import { currentState } from './engagement.js';
import { ttcOpenmaiAuthStatus } from './ttcsdk/auth.js';
import { ensureOpenClawProjectGroup } from './openclaw-group-access.js';
import { ensureAccessWithStatus } from './openclaw-group-status.js';

// specs/014：群内放行接单（job_action）——未接单时找人被拒，卡片又让人在群里接单，必须自洽。
const GROUP_PURPOSES = ['job_review', 'job_action', 'candidate_review', 'candidate_action', 'interview_prep'];

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
  const sharedLaunch = getProjectLaunch(db, consultantId, projectId);
  const reusesActiveSearch = sharedLaunch?.status === 'READY'
    && ['RUNNING', 'DONE'].includes(sharedLaunch.search_status);
  const searchReady = ttcConnected ?? ttcOpenmaiAuthStatus(db, consultantId).connected;
  if (requireSearch && !reusesActiveSearch && !searchReady) {
    blockers.push({ code: 'TTC_CREDENTIALS_REQUIRED', message: '请先配置个人或已授权的团队 TTC 寻访凭证' });
  }
  return { ready: blockers.length === 0, blockers, job, membership: membership?.relation || null, binding };
}

export function buildProjectLaunchCard(job, { publicBaseUrl, state = null } = {}) {
  const baseUrl = productionBaseUrl(publicBaseUrl).href;
  const detailUrl = buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: job.project_id });
  const facts = [job.city, job.hc == null ? null : `HC ${job.hc}`, job.pipeline].filter(Boolean).join(' · ');
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const accepted = String(state || '').toUpperCase() === 'ACCEPTED';
  const openmaiCommand = `为项目 ${projectRef} 使用 OpenMai 找人。读取本群最近一条由顾问明确发送的“找人条件：”作为补充条件；如果没有，就只根据职位事实自动找人。现在直接调用 brainx_openmai_search，不要再次询问找人方式。`;
  const reloopCommand = `为项目 ${projectRef} 使用 Reloop 内部人才库找人。读取本群最近一条由顾问明确发送的“找人条件：”作为补充条件；现在直接调用 brainx_candidate_shortlist，把候选人整理成清单，不要再次询问找人方式。`;
  const supermaiCommand = `为项目 ${projectRef} 使用 SuperMai 找人。读取本群最近一条由顾问明确发送的“找人条件：”作为补充条件；如果没有，就根据职位事实自动生成判据。现在直接调用 brainx_supermai_scout，不要再次询问找人方式。`;
  // 卡片输入框的值经 openclaw 回传时可能丢失（插件不解析 form_value），
  // 因此指令必须自带兜底：拿不到输入值就退回“找人条件：”或职位事实，不得卡住。
  const criteriaCommand = `为项目 ${projectRef} 按补充条件找人。优先使用卡片输入框里顾问填写的条件；如果你没有拿到输入值，就读取本群最近一条由顾问明确发送的“找人条件：”；两者都没有则只根据职位事实找人。现在直接调用 brainx_openmai_search，不要再次询问找人方式。`;
  const acceptCommand = `为项目 ${projectRef} 接单。现在直接调用 brainx_accept_job，参数为 { "job_id": "${projectRef}", "confirm": true }，不要再询问职位编号或二次确认。`;
  const searchActions = [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'OpenMai 找人' },
      value: { text: openmaiCommand } },
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'Reloop 找人' },
      value: { text: reloopCommand } },
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'SuperMai 找人' },
      value: { text: supermaiCommand } },
  ];
  const acceptActions = [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '接单' },
      value: { text: acceptCommand } },
  ];
  const elements = [
    { tag: 'markdown', content: `**${job.role}**\n${facts || '职位基础信息待补充'}\n\n`
      + `项目编号：${job.project_id}\n负责人：${job.consultant_name}` },
    { tag: 'markdown', content: accepted
      ? '**机器人已进入项目群，职位已接单**\n点按钮开始找人；也可以先在群里发送“找人条件：……”，再点「按条件找人」。'
      : '**机器人已进入项目群，该职位尚未接单**\n先点「接单」才能开始找人。机器人正在接入本群，如按钮暂无响应请稍候再点。' },
    { tag: 'action', actions: accepted ? searchActions : acceptActions },
  ];
  if (accepted) {
    elements.push({
      tag: 'input', name: 'criteria', required: false,
      placeholder: { tag: 'plain_text', content: '补充找人条件（可留空，例如：必须有半导体行业背景）' },
    });
    elements.push({ tag: 'action', actions: [
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '按条件找人' },
        value: { text: criteriaCommand } },
    ] });
  }
  elements.push({ tag: 'action', actions: [{
    tag: 'button', type: 'default', text: { tag: 'plain_text', content: '打开职位工作台' },
    multi_url: { url: detailUrl, pc_url: detailUrl, android_url: detailUrl, ios_url: detailUrl },
  }] });
  return {
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: `BrainTex 项目 · ${job.company}` } },
    elements,
  };
}

function saveFailure(db, launchId, code, message) {
  db.prepare(`UPDATE project_launches SET status='FAILED', error_code=?, error_message=?, updated_at=?
    WHERE launch_id=?`).run(code, message, now(), launchId);
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

export function getProjectLaunch(db, _consultantId, projectId) {
  return db.prepare(`SELECT launch_id, consultant_id, project_id, status, current_step, chat_id, chat_name,
    message_id, search_status, search_task_id, search_started_at,
    error_code, error_message, created_at, updated_at
    FROM project_launches WHERE project_id=?
    ORDER BY CASE status WHEN 'READY' THEN 0 WHEN 'POSTING_JOB' THEN 1
      WHEN 'CREATING_CHAT' THEN 2 ELSE 3 END, created_at, launch_id LIMIT 1`).get(projectId) || null;
}

function ensureSingleProjectLaunch(db, projectId) {
  const count = db.prepare('SELECT COUNT(*) AS count FROM project_launches WHERE project_id=?')
    .get(projectId).count;
  if (count > 1) fail(409, 'PROJECT_CHAT_CONFLICT', '该职位存在多个历史项目群，请管理员核对后再继续');
}

export function workflowDueAt() {
  const value = new Date(Date.now() + 2 * 86400000);
  value.setHours(18, 0, 0, 0);
  return value.toISOString();
}

/** 一次明确确认完成：项目群 → 接单行动；找人方式必须在群内另行选择。 */
export async function launchRecruitingWorkflow(db, bus, consultantId, projectId, input = {}, dependencies = {}) {
  if (input.confirm !== true) fail(422, 'CONFIRM_REQUIRED', '启动飞书寻访需要本次明确确认');
  const preflight = projectLaunchPreflight(db, consultantId, projectId, {
    appConfigured: dependencies.appConfigured,
    publicBaseUrl: dependencies.publicBaseUrl,
    requireSearch: false,
  });
  if (!preflight.ready) {
    const first = preflight.blockers[0];
    fail(409, first.code, first.message);
  }
  const group = await launchProject(db, consultantId, projectId, input, dependencies);
  const launchId = group.launch.launch_id;
  if (group.launch.consultant_id !== consultantId) {
    if (group.launch.status === 'READY' && ['RUNNING', 'DONE'].includes(group.launch.search_status)) {
      return { ok: true, group: group.launch, search: {
        status: group.launch.search_status === 'DONE' ? 'already_done' : 'running',
        task_id: group.launch.search_task_id,
        shared: true,
      }, launch: group.launch };
    }
    return { ok: true, group: group.launch, search: {
      status: 'awaiting_method', shared: true,
      message: '项目群已就绪，请在群内选择 OpenMai 或 SuperMai 后开始找人',
    }, launch: group.launch };
  }
  const state = currentState(db, consultantId, projectId).state;
  if (['COMPLETED', 'RELEASED'].includes(state)) {
    fail(409, 'PROJECT_NOT_ACTIVE', '该项目当前状态不能启动寻访');
  }
  if (state !== 'ACCEPTED') {
    const accepted = acceptCommitment(db, consultantId, projectId, {
      goal: '选择合适的找人方式并完成候选人搜索与匹配评估',
      action_title: '在项目群选择 OpenMai 或 SuperMai，并确认是否补充找人条件',
      due_at: workflowDueAt(),
      idempotency_key: `project-launch:${launchId}:accept`,
    });
    if (!accepted.ok) fail(accepted.status || 409, 'PROJECT_ACCEPT_FAILED', accepted.error);
  }
  const launch = getProjectLaunch(db, consultantId, projectId);
  return { ok: true, group: launch, search: {
    status: 'awaiting_method',
    message: '项目群已就绪，请在群内选择 OpenMai 或 SuperMai 后开始找人',
  }, launch };
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
  ensureSingleProjectLaunch(db, projectId);
  let launch = getProjectLaunch(db, consultantId, projectId);
  if (launch?.status === 'READY') return { ok: true, already: true, launch };
  if (launch && launch.consultant_id !== consultantId) {
    fail(409, 'PROJECT_LAUNCH_IN_PROGRESS', '该职位的项目群正由其他协作者创建，请稍后重试');
  }
  if (!launch) {
    const at = now();
    try {
      db.prepare(`INSERT INTO project_launches
        (launch_id, consultant_id, project_id, idempotency_key, status, current_step, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'CREATING_CHAT', 'CREATE_CHAT', ?, ?)`).run(
        randomUUID(), consultantId, projectId, idempotencyKey, at, at,
      );
    } catch (error) {
      if (String(error?.message || error).includes('PROJECT_LAUNCH_ALREADY_EXISTS')) {
        fail(409, 'PROJECT_LAUNCH_IN_PROGRESS', '该职位的项目群正由其他协作者创建，请稍后重试');
      }
      throw error;
    }
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
        WHERE launch_id=?`).run(
        chatId, created.name, now(), launch.launch_id,
      );
    }
    // specs/013：卡片是拉群的产物，先发；OpenClaw 群准入降级为 best-effort，
    // 失败只标 PENDING（由 openclaw-group-retry 补偿），不再废掉整条链路。
    const sent = await sendCard({
      target: chatId,
      card: buildProjectLaunchCard(preflight.job, { publicBaseUrl: dependencies.publicBaseUrl,
        state: currentState(db, consultantId, projectId).state }),
      idempotencyKey: `${launch.launch_id}-job`,
    });
    const openclaw = await ensureAccessWithStatus(allowOpenClawGroup, chatId, collaboratorOpenIds);
    db.exec('BEGIN');
    try {
      activateGroup(db, { consultantId, projectId, chatId,
        openIds: collaboratorOpenIds, binding: preflight.binding });
      db.prepare('UPDATE job_facts SET chat_id=?, updated_at=? WHERE project_id=?')
        .run(chatId, now(), projectId);
      db.prepare(`UPDATE project_launches SET status='READY', current_step='READY', message_id=?,
        openclaw_status=?, openclaw_error=?, openclaw_attempts=openclaw_attempts+1,
        openclaw_updated_at=?, error_code=NULL, error_message=NULL, updated_at=? WHERE launch_id=?`)
        .run(sent.message_id || null, openclaw.status, openclaw.error,
          now(), now(), launch.launch_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ok: true, already: false, openclaw, launch: getProjectLaunch(db, consultantId, projectId) };
  } catch (error) {
    const code = error.code || (chatId ? 'FEISHU_JOB_POST_FAILED' : 'FEISHU_CHAT_CREATE_FAILED');
    saveFailure(db, launch.launch_id, code, safeError(error));
    fail(502, code, chatId
      ? '项目群已创建，但机器人群准入、职位投放或本地登记失败；请重试'
      : '飞书项目群创建失败；请重试');
  }
}
