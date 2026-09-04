import { listConsultants } from '../roster.js';
import { latestRun } from '../recommend.js';
import { jobVisibleTo } from '../visibility.js';
import { relationOf } from '../relations.js';
import { currentState } from '../engagement.js';
import { startOpenmaiTask, getOpenmaiResult } from '../openmai-task.js';
import { supermaiScoutMatch, getSupermaiCredentials, markSupermaiReauth } from '../supermai-sourcing.js';
import { getPushPreferences } from '../push-preferences.js';

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
  return {
    data: {
      consultant_ref: 'self',
      display_name: consultant.display_name,
      profile_keywords: principal.chatType === 'p2p' ? consultant.profile_keywords || [] : [],
      accepted_count: Number(counts.accepted || 0),
      engaged_count: Number(counts.total || 0),
    },
    facts: [], inferences: [], recommendations: [], unknowns: [], evidence_refs: ['consultant:self'],
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

/** OpenMai 找人（第 11 工具，2026-09-03）：纪律与承接路由一致——
 * 仅本人 ACCEPTED/COMPLETED 的职位可触发/读取（fail-closed，不泄露存在性）。
 * 费用门控：done 读缓存、running 报状态、其他才触发新任务（防重复费用）。 */
function openmaiSearch(db, args, principal) {
  const row = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(args.job_id);
  if (!row || !jobVisibleTo(db, principal.consultantId, args.job_id)) fail('NOT_FOUND_OR_FORBIDDEN');
  const st = currentState(db, principal.consultantId, args.job_id)?.state;
  // 职位本人可见但未接单：明确提醒接单入口（不泄露任何额外信息——可见性已校验）
  if (!['ACCEPTED', 'COMPLETED'].includes(st)) fail('JOB_NOT_ACCEPTED');
  const cur = getOpenmaiResult(db, principal.consultantId, args.job_id) || {};
  if (cur.status === 'done' || cur.status === 'running') {
    return {
      data: { job_ref: args.job_id, status: cur.status, result_text: cur.result_text || null,
              started_at: cur.started_at || null, finished_at: cur.finished_at || null },
      facts: [], inferences: [], recommendations: [],
      unknowns: cur.status === 'running' ? ['找人任务进行中'] : [],
      evidence_refs: [`openmai:${cur.task_id || args.job_id}`],
    };
  }
  const out = startOpenmaiTask(db, null, principal.consultantId, args.job_id);
  return {
    data: { job_ref: args.job_id, status: out.status || 'triggered', task_id: out.task_id || null,
            note: '找人任务已触发，完成后再调本工具取结果（或在工作台承接面板查看）' },
    facts: [], inferences: [], recommendations: [], unknowns: [],
    evidence_refs: [`openmai:${out.task_id || args.job_id}`],
  };
}

/** SuperMai 多源搜索（第 22 工具，2026-09-03）：调用 SuperMai 云端 sourcing API
 * 在领英/GitHub/论文渠道搜索候选人，补充 OpenMai 的 BOSS/脉脉/猎聘渠道。
 * 凭证从 supermai_credentials 表读取（AES-GCM 加密，同 ttc_tokens 安全纪律）。 */
async function supermaiScout(db, args, principal) {
  const creds = getSupermaiCredentials(db, principal.consultantId);
  if (!creds) fail('SUPERMAI_UNAVAILABLE');
  try {
    const result = await supermaiScoutMatch({
      criteria: args.criteria,
      sources: args.sources,
      limit: args.limit,
      _credentials: creds,
    });
    return {
      data: result,
      facts: [],
      inferences: result.top_candidates?.slice(0, 3).map((c) => ({
        candidate_ref: c.ref_id, source: c.source_cn, name: c.name, score: c.score,
      })) || [],
      recommendations: result.top_candidates?.slice(0, 5).map((c) =>
        `[${c.source_cn}] ${c.name} ${c.score}分${c.headline ? ` ${c.headline}` : ''}｜${c.reason}`) || [],
      unknowns: result.empty_reason ? ['未找到匹配候选人，建议调整判据重试'] : [],
      evidence_refs: [`supermai_scout:${args.criteria.slice(0, 40)}`],
    };
  } catch (error) {
    // 凭证失效与源不可用都归一为 SUPERMAI_UNAVAILABLE：只影响「SuperMai 这一个外部源」，
    // 引导模型如实告诉顾问（OpenMai/内部推荐池不受影响），不再臆断全链路挂。
    if (error.code === 'AUTH_EXPIRED') markSupermaiReauth(db, principal.consultantId);
    if (['SUPERMAI_UNAVAILABLE', 'AUTH_EXPIRED', 'SOURCE_UNAVAILABLE'].includes(error.code)) {
      fail('SUPERMAI_UNAVAILABLE');
    }
    throw error;
  }
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
    brainx_supermai_scout: async (args, context) => supermaiScout(db, args, context.principal),
  };
}
