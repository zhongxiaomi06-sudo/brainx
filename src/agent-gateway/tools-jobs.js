import { listConsultants } from '../roster.js';
import { latestRun } from '../recommend.js';
import { jobVisibleTo } from '../visibility.js';
import { relationOf } from '../relations.js';
import { currentState } from '../engagement.js';
import { startOpenmaiTask, getOpenmaiResult } from '../openmai-task.js';
import { supermaiCriteriaKey, startSupermaiScoutTask } from '../supermai-sourcing.js';
import { extractOpenmaiCandidates, STALE_SEARCH_MS } from '../openmai-delivery.js';
import { getPushPreferences } from '../push-preferences.js';
import { nextSearchExclusions } from '../search-rounds.js';
import { ttcOpenmaiAuthStatus } from '../ttcsdk/auth.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function jsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJob(row) {
  return {
    project_id: row.project_id,
    company: row.company,
    role: row.role,
    city: row.city || null,
    pipeline: row.pipeline || null,
    hc: Number.isInteger(row.hc) ? row.hc : null,
    active_state: row.active_state,
    source_url: row.source_url || null,
    captured_at: row.captured_at,
  };
}

function shanghaiDate() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
}

function recommendationFor(db, consultantId, projectId) {
  const row = db.prepare(`SELECT decision_id, run_id, action, score, confidence_band,
      evidence_coverage, reasons_json, risks_json, evidence_refs_json, policy_version, created_at
    FROM recommendations WHERE consultant_id=? AND project_id=?
    ORDER BY created_at DESC, rank ASC LIMIT 1`).get(consultantId, projectId);
  if (!row) return null;
  return {
    decision_ref: row.decision_id,
    run_ref: row.run_id,
    action: row.action,
    score: row.score,
    confidence_band: row.confidence_band,
    evidence_coverage: row.evidence_coverage,
    reasons: jsonArray(row.reasons_json),
    risks: jsonArray(row.risks_json),
    evidence_refs: jsonArray(row.evidence_refs_json),
    policy_version: row.policy_version,
    created_at: row.created_at,
  };
}

function meContext(db, principal) {
  const consultant = listConsultants(db).find((row) => row.consultant_id === principal.consultantId);
  if (!consultant) fail('UNBOUND_IDENTITY');
  const counts = db.prepare(`SELECT
      SUM(CASE WHEN state='ACCEPTED' THEN 1 ELSE 0 END) accepted,
      COUNT(*) total
    FROM current_engagement WHERE consultant_id=?`).get(principal.consultantId);
  const latest = latestRun(db, principal.consultantId, { hideEngaged: true });
  const search = ttcOpenmaiAuthStatus(db, principal.consultantId);
  const push = getPushPreferences(db, principal.consultantId);
  const blockers = [];
  if (!latest) blockers.push({ code: 'JOB_RECOMMENDATION_MISSING', owner: '运营管理员', action: '先同步职位并完成一轮正式推荐计算' });
  if (!search.connected) blockers.push({ code: 'OPENMAI_ACCESS_MISSING', owner: 'BrainTex 管理员', action: '核验并授权团队 TTC/OpenMai 凭证' });
  return {
    data: {
      consultant_ref: 'self',
      display_name: consultant.display_name,
      profile_keywords: principal.chatType === 'p2p' ? consultant.profile_keywords || [] : [],
      accepted_count: Number(counts.accepted || 0),
      engaged_count: Number(counts.total || 0),
      onboarding: {
        bot_identity: 'ready',
        job_recommendations: latest ? 'ready' : 'action_required',
        openmai_search: search.connected ? 'ready' : 'action_required',
        daily_recommendations: push?.enabled ? 'ready' : 'disabled',
        daily_times: push?.times || [],
        daily_job_count: push?.job_count || 0,
        blockers,
      },
    },
    facts: [], inferences: [], recommendations: blockers.map((item) => ({
      action: item.action, owner: item.owner,
    })),
    unknowns: blockers.map((item) => item.code),
    evidence_refs: ['consultant:self', 'consultant_preferences:self',
      ...(latest ? [`decision_run:${latest.run.run_id}`] : [])],
  };
}

function dailyBrief(db, args, principal) {
  const preferred = getPushPreferences(db, principal.consultantId)?.job_count || 3;
  const limit = Math.min(args.limit || preferred, principal.chatType === 'group' ? 3 : 10);
  const latest = latestRun(db, principal.consultantId, { hideEngaged: true });
  if (!latest) return {
    data: { date: args.date || shanghaiDate(), items: [] },
    facts: [], inferences: [], recommendations: [],
    unknowns: ['暂无可用的正式推荐轮次，请先完成数据同步与推荐计算。'], evidence_refs: [],
  };
  const items = latest.items.slice(0, limit).map((item) => ({
    job: safeJob(item.job), rank: item.rank, score: item.score, action: item.action,
    confidence_band: item.confidence_band, reasons: item.reasons, risks: item.risks,
  }));
  return {
    data: { date: args.date || shanghaiDate(), run_ref: latest.run.run_id, items },
    facts: items.map((item) => ({ job_ref: item.job.project_id, company: item.job.company, role: item.job.role })),
    inferences: items.map((item) => ({ job_ref: item.job.project_id, score: item.score, band: item.confidence_band })),
    recommendations: items.map((item) => ({ job_ref: item.job.project_id, action: item.action, reasons: item.reasons })),
    unknowns: items.flatMap((item) => item.risks || []).slice(0, 10),
    evidence_refs: [`decision_run:${latest.run.run_id}`, ...items.map((item) => `job_fact:${item.job.project_id}`)],
    source_versions: { jobs: latest.run.snapshot_id, policy: latest.run.policy_version },
    next_allowed_actions: ['brainx_job_assessment', 'brainx_job_contacts', 'brainx_accept_job'],
  };
}

function jobAssessment(db, args, principal) {
  const row = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(args.job_id);
  if (!row || !jobVisibleTo(db, principal.consultantId, args.job_id)) fail('NOT_FOUND_OR_FORBIDDEN');
  const rec = recommendationFor(db, principal.consultantId, args.job_id);
  const unknowns = [];
  if (!row.city) unknowns.push('工作地点待确认');
  if (!Number.isInteger(row.hc)) unknowns.push('招聘人数待确认');
  if (!row.pipeline) unknowns.push('当前招聘进展待确认');
  return {
    data: { job: safeJob(row), relation: relationOf(db, principal.consultantId, args.job_id), engagement_state: currentState(db, principal.consultantId, args.job_id).state },
    facts: [{ job_ref: row.project_id, company: row.company, role: row.role, captured_at: row.captured_at }],
    inferences: rec ? [{ score: rec.score, confidence_band: rec.confidence_band, evidence_coverage: rec.evidence_coverage }] : [],
    recommendations: rec ? [{ action: rec.action, reasons: rec.reasons, risks: rec.risks }] : [],
    unknowns,
    evidence_refs: [`job_fact:${row.project_id}`, ...(rec ? [`recommendation:${rec.decision_ref}`] : [])],
    source_versions: { job_sync: row.sync_id, policy: rec?.policy_version || null },
    next_allowed_actions: ['brainx_gap_questions', 'brainx_job_contacts', 'brainx_accept_job', 'brainx_candidate_shortlist'],
  };
}

function gapQuestions(db, args, principal) {
  if (args.object_type !== 'job') fail('TOOL_DISABLED');
  const row = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(args.object_ref);
  if (!row || !jobVisibleTo(db, principal.consultantId, args.object_ref)) fail('NOT_FOUND_OR_FORBIDDEN');
  const candidates = [
    ['city', row.city, '这个职位的工作地点及到岗方式是什么？'],
    ['hc', Number.isInteger(row.hc) ? row.hc : null, '本轮明确开放多少个 HC，优先级如何？'],
    ['pipeline', row.pipeline, '当前已有多少推荐、面试和 Offer，最卡在哪一步？'],
    ['source_url', row.source_url, '职位原始页面或最新 JD 在哪里？'],
  ];
  const questions = candidates.filter(([, value]) => value === null || value === '').slice(0, 3)
    .map(([field, , question]) => ({ field, question }));
  return {
    data: { object_ref: args.object_ref, questions }, facts: [], inferences: [], recommendations: [],
    unknowns: questions.map((item) => `${item.field} 待确认`), evidence_refs: [`job_fact:${row.project_id}`],
  };
}

function personalReview(db, args, principal) {
  const from = Date.parse(`${args.date_from}T00:00:00.000+08:00`);
  const to = Date.parse(`${args.date_to}T23:59:59.999+08:00`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || to - from > 366 * 86400000) fail('INVALID_ARGUMENT');
  const events = db.prepare(`SELECT event_type, COUNT(*) count FROM decision_events
    WHERE actor=? AND occurred_at BETWEEN ? AND ? GROUP BY event_type`)
    .all(principal.consultantId, new Date(from).toISOString(), new Date(to).toISOString());
  const outcomes = db.prepare(`SELECT stage, COUNT(*) count FROM job_outcomes
    WHERE consultant_id=? AND observed_at BETWEEN ? AND ? GROUP BY stage`)
    .all(principal.consultantId, new Date(from).toISOString(), new Date(to).toISOString());
  return {
    data: {
      consultant_ref: 'self', date_from: args.date_from, date_to: args.date_to,
      events: events.reduce((sum, row) => sum + Number(row.count), 0),
      outcomes: outcomes.reduce((sum, row) => sum + Number(row.count), 0),
      event_breakdown: events, outcome_breakdown: outcomes,
    },
    facts: [...events.map((row) => ({ kind: 'event', type: row.event_type, count: row.count })),
      ...outcomes.map((row) => ({ kind: 'outcome', type: row.stage, count: row.count }))],
    inferences: [], recommendations: [], unknowns: [], evidence_refs: ['decision_events:self', 'job_outcomes:self'],
  };
}

function runStatus(db, args, principal) {
  const job = db.prepare(`SELECT job_id, kind, status, result_ref, attempts, max_attempts,
      requested_at, started_at, completed_at, error_code
    FROM integration_jobs WHERE job_id=? AND tenant_id=? AND consultant_id=?`).get(
    args.run_id, principal.tenantId, principal.consultantId,
  );
  const run = job || db.prepare(`SELECT run_id, status, tool_name, started_at, completed_at, error_code
    FROM agent_runs WHERE run_id=? AND tenant_id=? AND consultant_id=?`).get(
    args.run_id, principal.tenantId, principal.consultantId,
  );
  if (!run) fail('NOT_FOUND_OR_FORBIDDEN');
  return { data: run, facts: [{ run_ref: args.run_id, status: run.status }], inferences: [], recommendations: [], unknowns: [], evidence_refs: [`run:${args.run_id}`] };
}

function cleanSearchCriteria(value) {
  const criteria = String(value || '').trim();
  if (criteria.length > 2000) fail('INVALID_ARGUMENT');
  return criteria;
}

function projectCriteria(job, extra = '') {
  return [
    `目标职位：${job.role || '职位待确认'}`,
    job.city ? `工作城市：${job.city}` : null,
    job.company ? `客户业务背景：${job.company}` : null,
    Number.isInteger(job.hc) ? `招聘人数：${job.hc}` : null,
    job.pipeline ? `当前进展：${job.pipeline}` : null,
    extra ? `顾问补充条件：${extra}` : null,
  ].filter(Boolean).join('；').slice(0, 2000);
}

function activeProjectSearch(db, projectId) {
  // H-2：RUNNING 只在最近一小时内算「进行中」——投递/找人进程中断后 search_status
  // 可能永久停在 RUNNING（无租约兜底），超龄行不再短路新任务，让顾问能重新发起找人。
  // DONE 是终态，不受时间过滤（语义是「已有结果可复用」）。
  const cutoff = new Date(Date.now() - STALE_SEARCH_MS).toISOString();
  return db.prepare(`SELECT search_status,search_task_id FROM project_launches
    WHERE project_id=? AND status='READY'
      AND (search_status='DONE'
        OR (search_status='RUNNING' AND COALESCE(search_started_at,updated_at) > ?))
    ORDER BY created_at,launch_id LIMIT 1`).get(projectId, cutoff) || null;
}

function markProjectSearch(db, projectId, out) {
  const status = out.status === 'error' ? 'FAILED'
    : out.status === 'already_done' ? 'DONE' : 'RUNNING';
  db.prepare(`UPDATE project_launches SET search_status=?,search_task_id=?,
    search_started_at=COALESCE(search_started_at,?),error_code=?,error_message=?,updated_at=?
    WHERE project_id=? AND status='READY'`).run(
    status, out.task_id || null, out.started_at || new Date().toISOString(),
    status === 'FAILED' ? 'CANDIDATE_SEARCH_START_FAILED' : null,
    status === 'FAILED' ? String(out.message || '找人启动失败').slice(0, 240) : null,
    new Date().toISOString(), projectId,
  );
}

function sharedProjectSearch(projectId, active, entry) {
  return {
    data: { entry, job_ref: projectId,
      status: active.search_status === 'DONE' ? 'done' : 'running',
      task_id: active.search_task_id, shared: true },
    facts: [], inferences: [], recommendations: [],
    unknowns: active.search_status === 'RUNNING'
      ? ['该项目已有找人任务进行中。立即回复顾问“正在找人，通常需要 3-5 分钟，完成后候选人会自动发到本群”并结束本轮；'
         + '除非顾问之后明确询问进度，不要原地轮询']
      : [],
    evidence_refs: [`project_search:${active.search_task_id || projectId}`],
  };
}

function missingExclusions(projectId, entry) {
  return {
    data: { entry, job_ref: projectId, status: 'cannot_continue',
      excluded_candidate_refs: [] },
    facts: [], inferences: [], recommendations: [],
    unknowns: ['上一轮结果没有可确认的 TTC 候选编号；为避免重复推荐，本次未启动下一轮搜索'],
    evidence_refs: [`project_search:${projectId}`],
  };
}

/** 找人轮询守候纪律（2026-09-10 晚 wendy 会话教训）：模型曾以 1-2 秒间隔连打约 40 次
 * 后放弃守候并虚假承诺「设提醒」，导致结果躺库 31 分钟无人交付。修复：
 * ①响应带已运行时长（给模型耐心锚点）②硬性规定查询间隔 ≥60 秒
 * ③禁止承诺任何自动通知/提醒（bot 路径没有通知工具，bus=null）。 */
function pollDiscipline(startedAt, entry, autoDeliver = false) {
  const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : null;
  const mins = elapsed == null ? null : Math.floor(elapsed / 60);
  return {
    elapsed_seconds: elapsed,
    elapsed_minutes: mins,
    discipline: autoDeliver
      ? `项目找人任务进行中（${entry}），${mins != null ? `已运行 ${mins} 分钟、` : ''}正常 3-5 分钟收敛。`
        + '立即回复顾问“正在找人，完成后候选人会自动发到本群”并结束本轮；除非顾问之后明确询问进度，'
        + '不要原地连续轮询，也不要切换其他找人方式。'
      : `找人任务进行中（${entry}），${mins != null ? `已运行 ${mins} 分钟、` : ''}正常 3-5 分钟收敛——`
      + '两次查询之间必须间隔至少 60 秒，禁止连续快速调用本工具；最多守候 10 分钟，'
      + '若本任务由 continue_search=true 启动，轮询时必须改传 continue_search=false 或省略，绝不能再次传 true；'
      + '期间不要切换其他找人方式、不要尝试 read/exec 等文件工具（本环境不可用）。'
      + '结果就绪后必须把 result_text 完整呈现给顾问（保留每个候选人的「查看」链接）。'
      + '不要向顾问承诺任何「自动通知/设提醒」——本环境没有这类工具，超时未完成就如实告知顾问稍后再查。',
  };
}

/** OpenMai 找人（第 11 工具，2026-09-03）：纪律与承接路由一致——
 * 仅本人 ACCEPTED/COMPLETED 的职位可触发/读取（fail-closed，不泄露存在性）。
 * 费用门控：done 读缓存、running 报状态、其他才触发新任务（防重复费用）。 */
function openmaiSearch(db, args, principal) {
  const row = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(args.job_id);
  if (!row || !jobVisibleTo(db, principal.consultantId, args.job_id)) fail('NOT_FOUND_OR_FORBIDDEN');
  const st = currentState(db, principal.consultantId, args.job_id)?.state;
  // 职位本人可见但未接单：明确提醒接单入口（不泄露任何额外信息——可见性已校验）
  if (!['ACCEPTED', 'COMPLETED'].includes(st)) fail('JOB_NOT_ACCEPTED');
  const criteria = cleanSearchCriteria(args.criteria);
  const continuing = args.continue_search === true;
  const cur = getOpenmaiResult(db, principal.consultantId, args.job_id) || {};
  if (cur.status === 'running' || (cur.status === 'done' && !continuing)) {
    const disc = cur.status === 'running' ? pollDiscipline(cur.started_at, 'openmai', true) : null;
    return {
      data: { job_ref: args.job_id, status: cur.status, result_text: cur.result_text || null,
              started_at: cur.started_at || null, finished_at: cur.finished_at || null,
              ...(disc ? { elapsed_seconds: disc.elapsed_seconds, elapsed_minutes: disc.elapsed_minutes } : {}) },
      facts: [], inferences: [], recommendations: [],
      unknowns: disc ? [disc.discipline] : [],
      // done：结果就在 result_text（markdown 候选人清单），必须完整呈现给顾问，
      // 不能只回「已就绪」三个字（2026-09-04 wendy 案例：结果躺在表里 3 小时没人交付）。
      ...(cur.status === 'done' ? { recommendations: [{ action: 'present_result',
        note: '结果已就绪——请把 data.result_text 里的候选人列表完整、结构化地呈现给顾问，并询问下一步（约面/推荐）。' }] } : {}),
      evidence_refs: [`openmai:${cur.task_id || args.job_id}`],
    };
  }
  const shared = activeProjectSearch(db, args.job_id);
  if (shared?.search_status === 'RUNNING' || (shared && !continuing)) {
    return sharedProjectSearch(args.job_id, shared, 'openmai');
  }
  const exclusions = continuing ? nextSearchExclusions(db, args.job_id) : [];
  if (continuing && !exclusions.length) return missingExclusions(args.job_id, 'openmai');
  const out = startOpenmaiTask(db, null, principal.consultantId, args.job_id, {
    force: continuing, searchBrief: criteria, excludeCandidateRefs: exclusions,
  });
  markProjectSearch(db, args.job_id, out);
  return {
    data: { entry: 'openmai', job_ref: args.job_id, criteria: criteria || null,
            continue_search: continuing, excluded_candidate_refs: exclusions,
            status: out.status || 'triggered', task_id: out.task_id || null,
            message: out.message || null,
            note: out.status === 'error'
              ? '找人任务未启动，请处理提示后重试'
              : '找人任务已触发。立即回复顾问“正在找人，通常需要 3-5 分钟，完成后候选人会自动发到本群”并结束本轮；'
                + '除非顾问之后明确询问进度，不要原地轮询' },
    facts: [], inferences: [], recommendations: [], unknowns: [],
    evidence_refs: [`openmai:${out.task_id || args.job_id}`],
  };
}

/** SuperMai 按判据找人（第 22 工具；2026-09-08 按 specs/007 纠正重接）：
 * SuperMai 找人 = 猎聘/脉脉渠道 → 与 openmai_search 共用 OpenMai 引擎，
 * 本入口是「无需职位、直接给判据」的自由找人（completions 无 job_id 模式）。
 * 触发/读取两段式：首次调用触发任务返回 running，完成后同参数再调读取结果。 */
function supermaiScout(db, args, principal) {
  const jobId = String(args.job_id || '').trim();
  const continuing = args.continue_search === true;
  if (continuing && !jobId) fail('INVALID_ARGUMENT');
  const extra = cleanSearchCriteria(args.criteria);
  const job = jobId ? db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(jobId) : null;
  if (jobId && (!job || !jobVisibleTo(db, principal.consultantId, jobId))) fail('NOT_FOUND_OR_FORBIDDEN');
  if (jobId) {
    const st = currentState(db, principal.consultantId, jobId)?.state;
    if (!['ACCEPTED', 'COMPLETED'].includes(st)) fail('JOB_NOT_ACCEPTED');
  }
  const criteria = job ? projectCriteria(job, extra) : extra;
  if (criteria.length < 5) fail('INVALID_ARGUMENT');
  const project_id = jobId || supermaiCriteriaKey(criteria);
  const cur = getOpenmaiResult(db, principal.consultantId, project_id) || {};
  if (cur.status === 'running' || (cur.status === 'done' && !continuing)) {
    const candidates = cur.status === 'done' ? extractOpenmaiCandidates(cur.result_text) : [];
    const disc = cur.status === 'running' ? pollDiscipline(cur.started_at, 'supermai', Boolean(jobId)) : null;
    // NO_REPLY/空结果：OpenMai 对极窄判据可能零命中（返回占位符）——语义化为「未搜到」而非当成成功交付。
    const noReply = cur.status === 'done' && !candidates.length
      && ['NO_REPLY', ''].includes(String(cur.result_text || '').trim());
    return {
      data: { entry: 'supermai', job_ref: jobId || null, criteria, status: cur.status,
              result_text: noReply ? null : cur.result_text || null, candidates,
              empty_reason: noReply ? 'NO_MATCHES_FOUND' : null,
              started_at: cur.started_at || null, finished_at: cur.finished_at || null,
              ...(disc ? { elapsed_seconds: disc.elapsed_seconds, elapsed_minutes: disc.elapsed_minutes } : {}) },
      facts: [], inferences: [],
      recommendations: cur.status === 'done' && !noReply ? [{ action: 'present_result',
        note: '结果已就绪——请把 data.result_text 里的候选人列表完整、结构化地呈现给顾问，并询问下一步（约面/推荐）。' }] : [],
      unknowns: disc ? [disc.discipline]
        : noReply ? ['本轮未搜到匹配候选人——建议放宽判据（去掉具体公司名、缩短方向、拆成 2-3 个宽方向）后重新触发'] : [],
      evidence_refs: [`supermai:${cur.task_id || project_id}`],
    };
  }
  const shared = jobId ? activeProjectSearch(db, jobId) : null;
  if (shared?.search_status === 'RUNNING' || (shared && !continuing)) {
    return sharedProjectSearch(jobId, shared, 'supermai');
  }
  const exclusions = continuing ? nextSearchExclusions(db, jobId) : [];
  if (continuing && !exclusions.length) return missingExclusions(jobId, 'supermai');
  const out = startSupermaiScoutTask(db, null, principal.consultantId, criteria, {
    force: continuing, projectId: jobId || null, excludeCandidateRefs: exclusions,
  });
  if (jobId) markProjectSearch(db, jobId, out);
  return {
    data: { entry: 'supermai', job_ref: jobId || null, criteria,
            continue_search: continuing, excluded_candidate_refs: exclusions,
            status: out.status || 'triggered',
            task_id: out.task_id || null, message: out.message || null,
            note: out.status === 'already_done'
              ? '同判据结果已存在，请再次调用本工具读取'
              : out.status === 'error'
                ? '找人任务未启动，请处理提示后重试；正常启动后 3-5 分钟收敛，请每隔约 1 分钟读取进度'
              : jobId ? '找人任务已触发。立即回复顾问“正在找人，通常需要 3-5 分钟，完成后候选人会自动发到本群”并结束本轮；'
                + '除非顾问之后明确询问进度，不要原地轮询'
                : '找人任务已触发，正常 3-5 分钟收敛；请每隔约 1 分钟（间隔至少 60 秒）再调本工具读取'
                + '（最多守候 10 分钟），完成后完整呈现 result_text（保留「查看」链接）' },
    facts: [], inferences: [], recommendations: [], unknowns: [],
    evidence_refs: [`supermai:${out.task_id || project_id}`],
  };
}

export function createJobToolHandlers({ db }) {
  return {
    brainx_me_context: (args, context) => meContext(db, context.principal),
    brainx_daily_brief: (args, context) => dailyBrief(db, args, context.principal),
    brainx_job_assessment: (args, context) => jobAssessment(db, args, context.principal),
    brainx_gap_questions: (args, context) => gapQuestions(db, args, context.principal),
    brainx_personal_review: (args, context) => personalReview(db, args, context.principal),
    brainx_run_status: (args, context) => runStatus(db, args, context.principal),
    brainx_openmai_search: (args, context) => openmaiSearch(db, args, context.principal),
    brainx_supermai_scout: (args, context) => supermaiScout(db, args, context.principal),
  };
}
