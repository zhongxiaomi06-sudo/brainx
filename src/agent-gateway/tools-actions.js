import { acceptCommitment, recordProgress } from '../commitment.js';
import { currentState } from '../engagement.js';
import { confirmMembership } from '../membership.js';
import { jobVisibleTo } from '../visibility.js';
import { startOpenmaiTask } from '../openmai-task.js';
import { getPushPreferences, updatePushPreferences } from '../push-preferences.js';
import { buildProjectLaunchCard, launchProject, workflowDueAt } from '../project-launch.js';
import { bindGroupToProject, listBindableJobs } from '../group-intake.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function requireVisible(db, principal, jobId) {
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(jobId);
  if (!job || !jobVisibleTo(db, principal.consultantId, jobId)) fail('NOT_FOUND_OR_FORBIDDEN');
  return job;
}

function requireConfirmation(args) {
  if (args.confirm !== true) fail('INVALID_ARGUMENT');
}

function safeAction(action) {
  if (!action) return null;
  return { action_ref: action.action_id, title: action.title, due_at: action.due_at,
    status: action.status, source: action.source, updated_at: action.updated_at };
}

function acceptJob(db, args, principal, startSearch) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  // specs/011：goal/action_title/due_at/idempotency_key 服务端兜底——模型只传 job_id + confirm
  // 即可完成接单（york 案例：6 必填参数超出模型契约遵循能力，导致 09-01 以来 0 次成功调用）。
  const result = acceptCommitment(db, principal.consultantId, args.job_id, {
    goal: args.goal || '完成候选人搜索、筛选与匹配评估',
    action_title: args.action_title || '启动候选人搜索并跟进交付',
    due_at: args.due_at || workflowDueAt(),
    idempotency_key: args.idempotency_key || `bot:accept:${principal.consultantId}:${args.job_id}`,
  });
  if (!result.ok) fail(result.status === 404 ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
  // 2026-09-12 D5 灰测实证：agent 侧接单不落 MY_JOB 成员关系，随后 launchProjectChat
  // 必报 PROJECT_MEMBERSHIP_REQUIRED。与 web 一键接单对齐，接单即幂等写入成员关系。
  confirmMembership(db, principal.consultantId, args.job_id, {
    relation: 'MY_JOB',
    idempotency_key: `bot:membership:${principal.consultantId}:${args.job_id}`,
  });
  let search = null;
  if (!result.already || result.state === 'ACCEPTED') {
    search = startSearch(db, principal.consultantId, args.job_id);
  }
  const unknowns = [];
  // 项目搜索由投递 worker 自动回群；工具只要求模型给出即时可见状态后结束本轮。
  if (search?.status === 'triggered') {
    unknowns.push('候选人搜索已异步启动。立即回复顾问“正在找人，通常需要 3-5 分钟，完成后候选人会自动发到项目群”并结束本轮；'
      + '除非顾问之后明确询问进度，不要原地轮询。');
  } else if (search?.status === 'already_done') {
    unknowns.push('该岗位已有完成结果，用 brainx_openmai_search(job_id) 取回并呈现给顾问。');
  } else if (search?.status === 'error') {
    unknowns.push(`候选人搜索暂未启动：${search.message || '请稍后重试'}。`);
  }
  return {
    data: { job_ref: args.job_id, state: result.state, active_action: safeAction(result.active_action), search },
    facts: [{ job_ref: args.job_id, state: result.state }],
    inferences: [], recommendations: [], unknowns,
    evidence_refs: [`engagement:${args.job_id}`, `action:${result.active_action?.action_id || 'none'}`],
    next_allowed_actions: ['brainx_openmai_search', 'brainx_run_status', 'brainx_record_job_progress'],
  };
}

function startSearchForJob(db, args, principal, startSearch) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  if (currentState(db, principal.consultantId, args.job_id).state !== 'ACCEPTED') fail('JOB_NOT_ACCEPTED');
  const search = startSearch(db, principal.consultantId, args.job_id, { force: args.force === true });
  return {
    data: { job_ref: args.job_id, search }, facts: [{ job_ref: args.job_id, search_status: search.status }],
    inferences: [], recommendations: [], unknowns: search.message ? [search.message] : [],
    evidence_refs: [`openmai:${args.job_id}`], next_allowed_actions: ['brainx_run_status'],
  };
}

function recordJobProgress(db, args, principal) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  const result = recordProgress(db, principal.consultantId, args.job_id, {
    action_id: args.action_id,
    kind: args.kind,
    stage: args.stage,
    summary: args.summary,
    next_action: { title: args.next_action_title, due_at: args.next_due_at },
    idempotency_key: args.idempotency_key,
  });
  if (!result.ok) fail(result.status === 404 ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
  return {
    data: { job_ref: args.job_id, active_action: safeAction(result.active_action) },
    facts: [{ job_ref: args.job_id, progress_recorded: true, stage: args.stage || null }],
    inferences: [], recommendations: [], unknowns: [],
    evidence_refs: [`engagement:${args.job_id}`, `action:${result.active_action?.action_id || 'none'}`],
    next_allowed_actions: ['brainx_job_assessment'],
  };
}

/**
 * specs/015：把旧群绑定到职位。chat_id 取自 principal（不可由参数传，防越权）。
 * job_id 可选：不传返回顾问名下可绑职位清单让模型呈现给顾问选；传了 + confirm=true 才绑定。
 * 绑定由 bindGroupToProject 完成激活范围、回填 chat_id、发找人卡与拉群指引卡。
 */
async function bindGroupProject(db, args, principal, sendCardFn) {
  if (!args.job_id) {
    const jobs = listBindableJobs(db, principal.consultantId);
    return {
      data: { bindable_jobs: jobs },
      facts: jobs.map((job) => ({ job_ref: job.project_id, company: job.company, role: job.role })),
      inferences: [], recommendations: [],
      unknowns: jobs.length ? [] : ['你名下暂无可绑定职位，可先把 JD 粘贴到本群，或在工作台接单后再来绑定。'],
      evidence_refs: ['consultant:bindable_jobs'],
      next_allowed_actions: ['brainx_bind_group_project', 'brainx_submit_job_jd'],
    };
  }
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  try {
    const result = await bindGroupToProject(db, {
      consultantId: principal.consultantId, projectId: args.job_id, chatId: principal.chatId,
      publicBaseUrl: process.env.BRAINX_BASE_URL, sendCardFn,
    });
    return {
      data: { bound: true, project_id: result.project_id, chat_id: result.chat_id, state: result.state },
      facts: [{ job_ref: result.project_id, bound_chat: result.chat_id, state: result.state }],
      inferences: [], recommendations: [],
      unknowns: ['群已绑定，现在可以点找人按钮开始找人；拉群指引已发到你的私聊。'],
      evidence_refs: [`group_intake:${result.chat_id}`, `job_facts:${result.project_id}`],
      next_allowed_actions: ['brainx_openmai_search', 'brainx_candidate_shortlist', 'brainx_supermai_scout'],
    };
  } catch (error) {
    fail(error.code || 'BIND_FAILED');
  }
}

/**
 * specs/017：agent 侧建群入口。web 接单（specs/011）会自动建群，飞书对话里的
 * brainx_accept_job 不会——顾问在私聊接单后没有群，只能自己建群再点绑定卡（09-11 linda 投诉）。
 * 这里直接复用 013 的 launchProject：建群 → 发职位卡 → best-effort 准入 → 置 READY。
 * 幂等键按顾问+职位固定，重复调用只回 already，不重复建群。
 */
async function launchProjectChat(db, args, principal, launchProjectFn) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  const launchProjectImpl = launchProjectFn || launchProject;
  try {
    const result = await launchProjectImpl(db, principal.consultantId, args.job_id, {
      idempotency_key: `agent-launch:${principal.consultantId}:${args.job_id}`,
      force: args.force === true,
    }, { publicBaseUrl: process.env.BRAINX_BASE_URL });
    const launch = result.launch;
    return {
      data: { job_ref: args.job_id, chat_id: launch.chat_id, chat_name: launch.chat_name || null,
        status: launch.status, already: result.already === true, openclaw_status: launch.openclaw_status ?? null },
      facts: [{ job_ref: args.job_id, project_chat: launch.chat_id, status: launch.status }],
      inferences: [], recommendations: [],
      unknowns: result.already
        ? ['该项目群已经存在，直接在群里点找人按钮即可。']
        : ['项目群已建好，职位卡已发到群里；机器人正在接入本群（接入失败会自动重试，不影响找人）。'],
      evidence_refs: [`project_launch:${launch.launch_id}`, `job_facts:${args.job_id}`],
      next_allowed_actions: ['brainx_openmai_search', 'brainx_supermai_scout', 'brainx_candidate_shortlist'],
    };
  } catch (error) {
    fail(error.code || 'FEISHU_CHAT_CREATE_FAILED');
  }
}

/**
 * specs/014：群内接单成功后把「接单卡」换成「找人卡」。
 * 不换的话顾问手上那张卡还停在接单按钮，点第二次只会报错（york 22:14 之后的死循环）。
 * 发卡是 best-effort：失败不得回滚已经成功的接单。
 */
function sendAcceptedCard(db, jobId, sendCard) {
  if (typeof sendCard !== 'function') return;
  try {
    const launch = db.prepare(`SELECT chat_id FROM project_launches
      WHERE project_id=? AND status='READY' AND chat_id IS NOT NULL`).get(jobId);
    if (!launch) return;
    const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(jobId);
    if (!job) return;
    Promise.resolve(sendCard({
      target: launch.chat_id,
      card: buildProjectLaunchCard(job, { state: 'ACCEPTED' }),
      idempotencyKey: `accepted-card:${jobId}:${launch.chat_id}`,
    })).catch(() => {});
  } catch {
    // 发卡失败不影响接单结果
  }
}

export function createActionToolHandlers({ db, startSearchFn, sendCardFn, launchProjectFn } = {}) {
  const startSearch = startSearchFn || ((store, consultantId, jobId, options) => (
    startOpenmaiTask(store, null, consultantId, jobId, options)
  ));
  return {
    brainx_push_preferences: (_args, context) => ({
      data: { preferences: getPushPreferences(db, context.principal.consultantId) },
      facts: [], inferences: [], recommendations: [], unknowns: [], evidence_refs: ['consultant_preferences:self'],
      next_allowed_actions: ['brainx_update_push_preferences'],
    }),
    brainx_update_push_preferences: (args, context) => {
      requireConfirmation(args);
      const out = updatePushPreferences(db, context.principal.consultantId, args);
      if (!out.ok) fail('INVALID_ARGUMENT');
      return { data: out, facts: [{ preference_updated: true }], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: ['consultant_preferences:self'], next_allowed_actions: ['brainx_push_preferences'] };
    },
    brainx_job_contacts: (args, context) => {
      const job = requireVisible(db, context.principal, args.job_id);
      return { data: { job_ref: args.job_id, owner: job.owner_name ? {
        display_name: job.owner_name, owner_ref: job.owner_unique_id || null,
        linked_chat_available: Boolean(job.chat_id),
      } : null }, facts: [], inferences: [], recommendations: [],
      unknowns: job.owner_name ? [] : ['职位负责人尚未同步'], evidence_refs: [`job_fact:${args.job_id}`],
      next_allowed_actions: ['brainx_job_assessment'] };
    },
    brainx_accept_job: (args, context) => {
      const out = acceptJob(db, args, context.principal, startSearch);
      sendAcceptedCard(db, args.job_id, sendCardFn);
      return out;
    },
    brainx_start_candidate_search: (args, context) => startSearchForJob(db, args, context.principal, startSearch),
    brainx_record_job_progress: (args, context) => recordJobProgress(db, args, context.principal),
    // specs/015：旧群绑定职位。chat_id 取自 principal；job_id 可选——不传列职位，传了+confirm 绑定。
    brainx_bind_group_project: async (args, context) => bindGroupProject(db, args, context.principal, sendCardFn),
    // specs/017：agent 侧建群入口（飞书私聊接单后补建项目群）。
    brainx_launch_project_chat: async (args, context) => launchProjectChat(db, args, context.principal, launchProjectFn),
  };
}
