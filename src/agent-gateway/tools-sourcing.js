/** tools-sourcing.js — 找人工具 handler（brainx_openmai_search / brainx_supermai_scout）。
 *  2026-10-09 从 tools-jobs.js 拆出（500 行硬约束，为读回分支修复腾空间）。
 *  2026-10-09 断点修复（sourcing 三链路审计）：
 *  ① supermaiScout 接线补传 sendCardFn/publicBaseUrl——群读回发卡此前因丢参整链死亡；
 *  ③ 读回补 needs_input/failed 终态分支——此前穿透到触发分支，顾问问进度=静默重跑扣费；
 *  ⑫ running 读回补超龄判断——进程重启后的僵尸 running 不再谎称「进行中」。 */
import { jobVisibleTo, jobAccessibleFromGroup } from '../visibility.js';
import { currentState } from '../engagement.js';
import { startOpenmaiTask, getOpenmaiResult } from '../openmai-task.js';
import { supermaiCriteriaKey, startSupermaiScoutTask } from '../supermai-sourcing.js';
import { extractOpenmaiCandidates, buildOpenmaiDeliveryCard, STALE_SEARCH_MS } from '../openmai-delivery.js';
import { groupSafeOpenmaiText } from '../sourcing-result-card.js';
import { nextSearchExclusions, nextSupermaiSearchExclusions } from '../search-rounds.js';
import { registerFreeformDelivery } from '../sourcing-group-delivery.js';
import { careerStatusMap } from '../sourcing-candidates.js';
import { rejectedCandidateRefs } from '../candidate-search-feedback.js';
import { internalFirst } from './search-internal-first.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function shanghaiDate() {
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
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

/** 找人读回的终态分支（断点③⑫）：needs_input / failed / 超龄 running（进程重启僵尸）
 *  统一如实告知，绝不穿透到触发分支静默重跑付费任务；重新发起必须由顾问明确表达
 *  （continue_search=true 通道），失败 60s 冷却仍由 start*Task 兜底。 */
function terminalSearchEnvelope({ entry, jobRef, criteria = null, cur, stale }) {
  const needsInput = cur.status === 'needs_input';
  return {
    data: { entry, job_ref: jobRef, ...(criteria != null ? { criteria } : {}),
      status: needsInput ? 'needs_input' : 'failed',
      result_text: needsInput ? cur.result_text || null : null,
      error: needsInput ? null : cur.error || null,
      started_at: cur.started_at || null, finished_at: cur.finished_at || null },
    facts: [], inferences: [],
    recommendations: [needsInput
      ? { action: 'collect_brief',
        note: 'OpenMai 要求补充职位信息——把 data.result_text 的原文如实转达顾问，请其补充'
          + '（方向/职责/目标公司/关键经验/薪资范围），补齐后把补充内容放进 criteria 重新调用本工具。' }
      : { action: 'confirm_retry',
        note: '上一轮找人未完成，本次没有重新发起（避免未经确认重复扣费）——如实告知顾问失败/中断原因；'
          + '顾问明确说「重新找人」后，用 continue_search=true 重新调用本工具。' }],
    unknowns: [needsInput
      ? 'OpenMai 认为职位信息不足，本轮没有产生候选人。'
      : stale
        ? '上一轮找人任务因服务中断或超时未正常完成（任务进程已不在运行）。'
        : `上一轮找人失败：${String(cur.error || '原因未知').slice(0, 200)}`],
    evidence_refs: [`${entry}:${cur.task_id || jobRef}`],
  };
}

/** 续搜排除名单闸门：只有上一轮成功交付过候选人（done）时才要求可确认的排除名单——
 *  failed/needs_input/零命中轮次没有可重复推荐的人，不得把顾问卡在 cannot_continue。 */
function continuingGate(cur, exclusions, projectId, entry) {
  return exclusions.length === 0 && cur.status === 'done'
    && !['', 'NO_REPLY'].includes(String(cur.result_text || '').trim())
    ? missingExclusions(projectId, entry) : null;
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
      + '不要向顾问承诺任何「自动通知/设提醒」——本环境没有这类工具，超时未完成就如实告知顾问稍后再查。',
  };
}

function runningStale(cur) {
  return cur.status === 'running'
    && Date.now() - Date.parse(cur.started_at || 0) >= STALE_SEARCH_MS;
}

/** 外部引擎漏遵守排除时，读回也不让模型看到原始全文里的已排除人选。 */
function visibleReadback(db, principal, projectId, resultText) {
  const excluded = new Set(rejectedCandidateRefs(db, projectId, principal));
  const candidates = extractOpenmaiCandidates(resultText)
    .filter((candidate) => !excluded.has(candidate.candidateRef));
  if (!excluded.size) return { candidates, resultText };
  return { candidates, resultText: candidates.length
    ? candidates.map((candidate, index) => `${index + 1}. ${groupSafeOpenmaiText(candidate.name, 60)} · `
        + `${groupSafeOpenmaiText(candidate.role, 120)} · ${groupSafeOpenmaiText(candidate.city, 40)}`).join('\n')
    : '本轮没有可安全展示的人选；已排除的人选不会再次展示。' };
}

/** 群上下文 done 读回：把标准候选人卡确定性发到本群（best-effort，失败不阻断）。
 *  幂等键按 职位×群×轮次×日 去重防刷屏；只有发卡调用成功才返回 true。
 *  specs/036：带生涯徽标（sourcing_candidates 缺表按无徽标渲染）。 */
async function trySendOpenmaiResultCard(db, sendCardFn, publicBaseUrl, args, principal, row, cur, source = 'openmai') {
  if (!sendCardFn || principal.chatType !== 'group' || !principal.chatId) return false;
  try {
    let careerMap = null;
    try { careerMap = careerStatusMap(db, { searchKey: args.job_id,
      consultantId: principal.consultantId, tenantId: principal.tenantId }); }
    catch { /* best-effort 徽标 */ }
    await sendCardFn({
      target: principal.chatId,
      card: buildOpenmaiDeliveryCard({
        job: { ...row, search_round: cur.search_round || 1,
          search_brief: cur.search_brief, excluded_candidate_refs_json: cur.excluded_candidate_refs_json },
        status: cur.status, resultText: cur.result_text, error: cur.error, publicBaseUrl, source,
        careerStatusMap: careerMap,
      }),
      idempotencyKey: `openmai-result-card:${args.job_id}:${principal.chatId}:round${cur.search_round || 1}:${shanghaiDate()}`,
    });
    return true;
  } catch { return false; }
}

/** OpenMai 找人（第 11 工具，2026-09-03）：纪律与承接路由一致——
 * 仅本人 ACCEPTED/COMPLETED 的职位可触发/读取（fail-closed，不泄露存在性）。
 * 费用门控：done 读缓存、running 报状态、终态如实告知，其他才触发新任务（防重复费用）。 */
async function openmaiSearch(db, args, principal, sendCardFn, publicBaseUrl, internalShortlistFn) {
  const row = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(args.job_id);
  if (!row || (!jobVisibleTo(db, principal.consultantId, args.job_id)
      && !jobAccessibleFromGroup(db, principal, args.job_id))) fail('NOT_FOUND_OR_FORBIDDEN');
  const st = currentState(db, principal.consultantId, args.job_id)?.state;
  // 职位本人可见但未接单：明确提醒接单入口（不泄露任何额外信息——可见性已校验）
  if (!['ACCEPTED', 'COMPLETED'].includes(st)
      && !jobAccessibleFromGroup(db, principal, args.job_id)) fail('JOB_NOT_ACCEPTED');
  const criteria = cleanSearchCriteria(args.criteria);
  const continuing = args.continue_search === true;
  const cur = getOpenmaiResult(db, principal.consultantId, args.job_id) || {};
  const stale = runningStale(cur);
  if ((cur.status === 'running' && !stale) || (cur.status === 'done' && !continuing)) {
    const disc = cur.status === 'running' ? pollDiscipline(cur.started_at, 'openmai', true) : null;
    // 群上下文 done 读回：候选人名单由标准卡片承担（代码渲染），envelope 只留引导语；
    // 私聊 / 缺 sendCardFn / 发卡失败维持原样（result_text 原样带出）。
    const cardSent = cur.status === 'done'
      && await trySendOpenmaiResultCard(db, sendCardFn, publicBaseUrl, args, principal, row, cur);
    const visible = cur.status === 'done'
      ? visibleReadback(db, principal, args.job_id, cur.result_text) : null;
    return {
      data: { job_ref: args.job_id, status: cur.status,
              result_text: cardSent ? null : visible?.resultText || cur.result_text || null,
              ...(cardSent ? { card_delivered: true } : {}),
              started_at: cur.started_at || null, finished_at: cur.finished_at || null,
              ...(disc ? { elapsed_seconds: disc.elapsed_seconds, elapsed_minutes: disc.elapsed_minutes } : {}) },
      facts: [], inferences: [], recommendations: [],
      unknowns: [
        ...(disc ? [disc.discipline] : []),
        // 2026-09-13 实证：模型在复用分支自编「已避开 N 人」并冒充新一轮。
        // 复用时必须明说，排除名单只在显式新一轮由 BrainX 生成。
        ...(cur.status === 'done' ? [`这是第 ${cur.search_round || 1} 轮已完成结果的复用，不是新一轮找人；`
          + '不要声称启动了新一轮，也不要声称「已避开」任何候选人——排除名单只在显式新一轮（continue_search=true）时由 BrainX 生成。'] : []),
      ],
      // done：结果就在 result_text（markdown 候选人清单），必须完整呈现给顾问，
      // 不能只回「已就绪」三个字（2026-09-04 wendy 案例：结果躺在表里 3 小时没人交付）。
      // 群上下文已发卡时改为引导纪律：名单在卡片上，模型不得再罗列。
      ...(cur.status === 'done' ? { recommendations: [cardSent
        ? { action: 'guide_only',
          note: '候选人结果卡片已发到本群——只回一句话引导群友点卡片上的按钮（初筛通过 / 加入reloop / 继续找人），'
            + '不要在回复里罗列候选人名单、评分或匹配百分比。' }
        : { action: 'present_result',
          note: '结果已就绪——请把 data.result_text 里的候选人列表完整、结构化地呈现给顾问，并询问下一步（约面/推荐）。' }] } : {}),
      evidence_refs: [`openmai:${cur.task_id || args.job_id}`],
    };
  }
  // 终态如实告知（needs_input/failed/僵尸 running），不静默重跑；
  // 顾问明确重新找人（continue_search=true）时跳过本分支直达触发。
  if (!continuing && (['needs_input', 'failed'].includes(cur.status) || stale)) {
    return terminalSearchEnvelope({ entry: 'openmai', jobRef: args.job_id, cur, stale });
  }
  const shared = activeProjectSearch(db, args.job_id);
  if (shared?.search_status === 'RUNNING' || (shared && !continuing)) {
    return sharedProjectSearch(args.job_id, shared, 'openmai');
  }
  const exclusions = continuing ? nextSearchExclusions(db, args.job_id, principal)
    : rejectedCandidateRefs(db, args.job_id, principal);
  const blocked = continuing && continuingGate(cur, exclusions, args.job_id, 'openmai');
  if (blocked) return blocked;
  const internal = await internalFirst(internalShortlistFn, args.job_id, principal);
  const concurrent = activeProjectSearch(db, args.job_id);
  if (concurrent?.search_status === 'RUNNING') return sharedProjectSearch(args.job_id, concurrent, 'openmai');
  const out = startOpenmaiTask(db, null, principal.consultantId, args.job_id, {
    force: continuing, searchBrief: criteria, excludeCandidateRefs: exclusions,
  });
  markProjectSearch(db, args.job_id, out);
  return {
    data: { entry: 'openmai', job_ref: args.job_id, criteria: criteria || null, internal_shortlist: internal,
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
async function supermaiScout(db, args, principal, sendCardFn, publicBaseUrl, internalShortlistFn, sendTextMessageFn) {
  const jobId = String(args.job_id || '').trim();
  const continuing = args.continue_search === true;
  const extra = cleanSearchCriteria(args.criteria);
  const job = jobId ? db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(jobId) : null;
  if (jobId && (!job || (!jobVisibleTo(db, principal.consultantId, jobId)
      && !jobAccessibleFromGroup(db, principal, jobId)))) fail('NOT_FOUND_OR_FORBIDDEN');
  if (jobId) {
    const st = currentState(db, principal.consultantId, jobId)?.state;
    if (!['ACCEPTED', 'COMPLETED'].includes(st)
        && !jobAccessibleFromGroup(db, principal, jobId)) fail('JOB_NOT_ACCEPTED');
  }
  const criteria = job ? projectCriteria(job, extra) : extra;
  if (criteria.length < 5) fail('INVALID_ARGUMENT');
  const project_id = jobId || supermaiCriteriaKey(criteria);
  const cur = getOpenmaiResult(db, principal.consultantId, project_id) || {};
  const stale = runningStale(cur);
  if ((cur.status === 'running' && !stale) || (cur.status === 'done' && !continuing)) {
    const visible = cur.status === 'done'
      ? visibleReadback(db, principal, project_id, cur.result_text) : null;
    const candidates = visible?.candidates || [];
    const autoDeliver = Boolean(jobId) || registerFreeformDelivery(db, principal, project_id);
    const disc = cur.status === 'running' ? pollDiscipline(cur.started_at, 'supermai', autoDeliver) : null;
    // NO_REPLY/空结果：OpenMai 对极窄判据可能零命中（返回占位符）——语义化为「未搜到」而非当成成功交付。
    const noReply = cur.status === 'done' && !candidates.length
      && ['NO_REPLY', ''].includes(String(cur.result_text || '').trim());
    // 项目模式 + 群上下文 + 已完成：确定性发结果卡（与 openmai_search 同一纪律），
    // envelope 不再带名单——模型只回引导语，多轮对话后不再自由排版（2026-09-16 linda 实证）。
    // 自由找人模式（无 jobId）也发卡：拼合成 job 传给卡片函数（2026-09-16 specs/018）。
    const synthJob = jobId ? job : {
      project_id, company: '自由找人', role: (criteria || '').slice(0, 60),
      search_round: cur.search_round || 1, freeform: true, criteria,
    };
    const cardSent = cur.status === 'done' && !noReply
      && await trySendOpenmaiResultCard(db, sendCardFn, publicBaseUrl, { job_id: project_id }, principal, synthJob, cur, 'supermai');
    return {
      data: { entry: 'supermai', job_ref: jobId || null, criteria, status: cur.status,
              result_text: cardSent ? null : (noReply ? null : visible?.resultText || null),
              candidates: cardSent ? [] : candidates,
              ...(cardSent ? { card_delivered: true } : {}),
              empty_reason: noReply ? 'NO_MATCHES_FOUND' : null,
              started_at: cur.started_at || null, finished_at: cur.finished_at || null,
              ...(disc ? { elapsed_seconds: disc.elapsed_seconds, elapsed_minutes: disc.elapsed_minutes } : {}) },
      facts: [], inferences: [],
      recommendations: !cardSent && cur.status === 'done' && !noReply ? [{ action: 'present_result',
        note: '结果已就绪——请把 data.result_text 里的候选人列表完整、结构化地呈现给顾问，并询问下一步（约面/推荐）。' }] : [],
      unknowns: cardSent ? ['结果卡已发到本群：只用一句话引导群友点卡片上的按钮（初筛通过/加入reloop/继续找人），不要在回复里罗列名单、评分或自制表格。']
        : disc ? [disc.discipline]
        : noReply ? ['本轮未搜到匹配候选人——建议放宽判据（去掉具体公司名、缩短方向、拆成 2-3 个宽方向）后重新触发']
        : cur.status === 'done' ? [`这是第 ${cur.search_round || 1} 轮已完成结果的复用，不是新一轮找人；`
          + '不要声称启动了新一轮，也不要声称「已避开」任何候选人——排除名单只在显式新一轮（continue_search=true）时由 BrainX 生成。']
        : [],
      evidence_refs: [`supermai:${cur.task_id || project_id}`],
    };
  }
  // 终态如实告知（needs_input/failed/僵尸 running），不静默重跑；
  // 顾问明确重新找人（continue_search=true）时跳过本分支直达触发。
  if (!continuing && (['needs_input', 'failed'].includes(cur.status) || stale)) {
    return terminalSearchEnvelope({ entry: 'supermai', jobRef: jobId || null, criteria, cur, stale });
  }
  const shared = jobId ? activeProjectSearch(db, jobId) : null;
  if (shared?.search_status === 'RUNNING' || (shared && !continuing)) {
    return sharedProjectSearch(jobId, shared, 'supermai');
  }
  // 续搜排除名单按落库主键取（自由找人=合成键），不再限 job 模式——自由找人也可续搜。
  const exclusions = continuing ? nextSupermaiSearchExclusions(db, project_id, principal)
    : rejectedCandidateRefs(db, project_id, principal);
  const blocked = continuing && continuingGate(cur, exclusions, project_id, 'supermai');
  if (blocked) return blocked;
  const internal = await internalFirst(internalShortlistFn, jobId, principal);
  const concurrent = jobId ? activeProjectSearch(db, jobId) : null;
  if (concurrent?.search_status === 'RUNNING') return sharedProjectSearch(jobId, concurrent, 'supermai');
  // specs/036：付费触发前统计本人近 30 天未排除的历史人选数——供 agent 提示「可先用 recall 免费筛选」，
  // 不做静默拦截（顾问明确要新人才启动，脑内判断权留给顾问）。
  let knownRecent = 0;
  try {
    knownRecent = db.prepare(`SELECT COUNT(*) c FROM sourcing_candidates
      WHERE consultant_id=? AND career_status!='rejected' AND updated_at>=?`)
      .get(principal.consultantId, new Date(Date.now() - 30 * 86_400_000).toISOString()).c;
  } catch { knownRecent = 0; }
  const out = startSupermaiScoutTask(db, null, principal.consultantId, criteria, {
    force: continuing, projectId: jobId || null, excludeCandidateRefs: exclusions,
  });
  const autoDeliver = Boolean(jobId) || (['triggered', 'running'].includes(out.status)
    && registerFreeformDelivery(db, principal, project_id));
  if (jobId) markProjectSearch(db, jobId, out);
  // specs/036：触发成功后 best-effort 发状态消息（等待期有反馈），失败不阻断。
  if (autoDeliver && ['triggered', 'running'].includes(out.status) && sendTextMessageFn) {
    try {
      await sendTextMessageFn({ target: principal.chatId,
        text: '正在按判据找人，通常 3-5 分钟收敛，完成后结果卡片会自动发到本群。',
        idempotencyKey: `scout-status:${out.task_id}` });
    } catch { /* 状态消息 best-effort，失败不影响任务 */ }
  }
  return {
    data: { entry: 'supermai', job_ref: jobId || null, criteria, internal_shortlist: internal,
            continue_search: continuing, excluded_candidate_refs: exclusions,
            known_recent_candidates: knownRecent,
            status: out.status || 'triggered',
            task_id: out.task_id || null, message: out.message || null,
            note: out.status === 'already_done'
              ? '同判据结果已存在，请再次调用本工具读取'
              : out.status === 'error'
                ? '找人任务未启动，请处理提示后重试；正常启动后 3-5 分钟收敛，请每隔约 1 分钟读取进度'
              : autoDeliver ? '找人任务已触发。立即回复顾问“正在找人，通常需要 3-5 分钟，完成后候选人会自动发到本群”并结束本轮；'
                + '除非顾问之后明确询问进度，不要原地轮询'
                : '找人任务已触发，正常 3-5 分钟收敛；请每隔约 1 分钟（间隔至少 60 秒）再调本工具读取'
                + '（最多守候 10 分钟），完成后完整呈现 result_text（保留「查看」链接）' },
    facts: [], inferences: [],
    recommendations: knownRecent >= 3 && out.status === 'triggered'
      ? [{ action: 'mention_recall',
        note: `启动前提醒：本人近 30 天已有 ${knownRecent} 个历史搜索人选（未排除），`
          + '若顾问只是想在已有结果里筛选（如按公司/城市/背景），改用 brainx_sourcing_recall 免费秒查；'
          + '本次已按顾问明确指令启动新搜索，不要撤销。' }]
      : [],
    unknowns: [],
    evidence_refs: [`supermai:${out.task_id || project_id}`],
  };
}

export function createSourcingToolHandlers({ db, sendCardFn = null, publicBaseUrl = process.env.BRAINX_BASE_URL,
  internalShortlistFn, sendTextMessageFn = null } = {}) {
  return {
    brainx_openmai_search: (args, context) => openmaiSearch(db, args, context.principal, sendCardFn, publicBaseUrl, internalShortlistFn),
    brainx_supermai_scout: (args, context) => supermaiScout(db, args, context.principal, sendCardFn, publicBaseUrl, internalShortlistFn, sendTextMessageFn),
  };
}
