/** recommend.js — 生成一轮推荐并冻结（PRD §6/§8，补全文档 §13.4）。
 * 只读最近 complete=1 快照；冻结 recommendations；精选盘使用冻结 Top20。
 *
 * 2026-08-10 框架修正：
 *   - 关系一律走 relations.js 推导（本人行 > 他人主做 → OTHER_CONSULTANT >
 *     团队池默认 TEAM_SHARED）。修正前无本人关系行的职位全被打成 UNKNOWN 硬阻断，
 *     mia/york 的推荐池恒为空（桥接事实进不了推荐 = 主链路断链）；
 *   - latestRun 出网前剥离 raw_json（修正前 workbench/recommendations/MCP
 *     每条推荐都携带整段原始负载，既泄露又臃肿）。
 */
import { now, uuid } from './db.js';
import { latestCompleteSnapshot, latestRealSync, latestBridgeError, friendlyBridgeError } from './sync.js';
import { WEIGHTS, POLICY_VERSION, hardBlock, scoreJob, actionOf, sortRecs, explain, normalizeWeights } from './scorer.js';
import { listConsultants } from './roster.js';
import { relationMap, deriveRelation } from './relations.js';
import { effectiveJobs } from './facts.js';
import { dataConfidenceOf, presentationEvidence, recommendationPresentationOf } from './recommendation-presentation.js';

/** 花名册从 DB 读（0003 起 consultants 表为权威，fixtures 只是种子）。 */
export function loadConsultants(db) {
  return listConsultants(db);
}

export function buildCtx(db, consultant_id, snapshot) {
  const c = loadConsultants(db).find((x) => x.consultant_id === consultant_id) || {};
  // 历史 MY_JOB 文本（含已关闭/过期关系 → 历史相似度，§17.2-2）
  const hist = db.prepare(`SELECT DISTINCT j.company || ' ' || j.role AS text
    FROM job_memberships m JOIN job_facts j ON j.project_id = m.project_id
    WHERE m.consultant_id=? AND m.relation IN ('MY_JOB','PRIMARY_PM')`).all(consultant_id);
  const watched = db.prepare(`SELECT COUNT(*) n FROM current_engagement
    WHERE consultant_id=? AND state='WATCHED'`).get(consultant_id).n;
  const accepted = db.prepare(`SELECT COUNT(*) n FROM current_engagement
    WHERE consultant_id=? AND state='ACCEPTED'`).get(consultant_id).n;
  const avg = db.prepare(`SELECT AVG(json_extract(value_json,'$.rating')) a FROM job_outcomes
    WHERE consultant_id=? AND json_extract(value_json,'$.rating') IS NOT NULL`).get(consultant_id).a;
  const feedbackProjects = db.prepare(`SELECT project_id FROM recommendation_feedback
    WHERE consultant_id=?`).all(consultant_id).map((row) => row.project_id);
  // 反馈闭环（baseline-1.1）：公司级记忆 + 僵尸职位检测信号
  const negCompanies = db.prepare(`SELECT DISTINCT j.company FROM decision_events e
    JOIN job_facts j ON j.project_id=e.project_id
    WHERE e.actor=? AND e.event_type='DISMISSED'
    UNION SELECT DISTINCT j.company FROM recommendation_feedback f
    JOIN job_facts j ON j.project_id=f.project_id
    WHERE f.consultant_id=?`).all(consultant_id, consultant_id).map((r) => r.company);
  const posCompanies = db.prepare(`SELECT DISTINCT j.company FROM decision_events e
    JOIN job_facts j ON j.project_id=e.project_id
    WHERE e.actor=? AND e.event_type='ACCEPTED'`).all(consultant_id).map((r) => r.company);
  const recRounds = Object.fromEntries(db.prepare(`SELECT project_id, COUNT(DISTINCT run_id) n FROM recommendations
    WHERE consultant_id=? GROUP BY project_id`).all(consultant_id)
    .map((r) => [r.project_id, r.n]));
  const engagedProjects = new Set(db.prepare(`SELECT DISTINCT project_id FROM decision_events
    WHERE actor=? AND event_type != 'RECOMMENDED'`).all(consultant_id).map((r) => r.project_id));
  return {
    consultant_id,
    profile_keywords: c.profile_keywords || [],
    // 承接容量上限：顾问档案 profile_json 里可配 capacity_limit；缺省时 scorer 用 CAPACITY_LIMIT。
    capacity_limit: Number(c.capacity_limit) > 0 ? Number(c.capacity_limit) : undefined,
    // 顾问级六维权重覆盖（规则页滑杆接真 policy，2026-08-25）：profile_json.weights，
    // 经 normalizeWeights 校验归一；非法配置静默回落基线（不阻断推荐）。
    weights: normalizeWeights(c.weights ?? null).weights ?? undefined,
    historical_texts: hist.map((h) => h.text),
    watched_count: watched, accepted_count: accepted,
    outcomes_avg: avg, feedback_projects: feedbackProjects,
    negative_companies: negCompanies, positive_companies: posCompanies,
    rec_rounds: recRounds, engaged_projects: engagedProjects,
    now: now(), snapshot_id: snapshot?.sync_id || '',
  };
}

/** 自动轮次最小冻结间隔：桥接输入变化也不得绕过，人工重算不受限制。 */
const THROTTLE_MS = Number(process.env.BRAINX_RECOMMEND_THROTTLE_MS || 2 * 3600 * 1000);
const SKIP_AUDIT_MS = Number(process.env.BRAINX_SKIP_AUDIT_MS || 60 * 60 * 1000);
const PERSIST_LIMIT = Number(process.env.BRAINX_RECOMMEND_PERSIST_LIMIT || 200);
const RETAIN_RUNS = Number(process.env.BRAINX_RECOMMEND_RETAIN_RUNS || 3);

/**
 * 推荐属于可再生成快照，不得无限累积。保留最近若干正式轮次；被结果记录引用的
 * 推荐继续保留，避免破坏人工结果的证据链。decision_runs 本身很小，作为审计行保留。
 */
export function pruneRecommendationHistory(db, consultant_id, retainRuns = RETAIN_RUNS) {
  const keep = Math.max(1, Number(retainRuns) || RETAIN_RUNS);
  const stale = db.prepare(`SELECT run_id FROM decision_runs
    WHERE consultant_id=? AND status='COMPLETED'
    ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`).all(consultant_id, keep);
  const remove = db.prepare(`DELETE FROM recommendations WHERE run_id=?
    AND decision_id NOT IN (SELECT decision_id FROM job_outcomes WHERE decision_id IS NOT NULL)`);
  let removed = 0;
  for (const row of stale) removed += remove.run(row.run_id).changes;
  return { stale_runs: stale.length, removed };
}

/**
 * 生成一轮推荐。硬约束：最近同步 complete=0 → blocked，不落推荐。
 * throttle=true（桥接等自动路径）：距上一正式轮 <2h → 跳过冻结，
 * 记一行 SKIPPED_THROTTLED 审计轮并返回上轮 run_id（手动 run/事实修正重算不传，强制全量）。
 * 返回 { run_id, blocked, items[] }；dry_run 不落库。
 */
export function recommend(db, consultant_id, {
  top = 20, dry_run = false, throttle = false, persistLimit = PERSIST_LIMIT,
} = {}) {
  // 阻断判定只看真实同步（2026-08-25）：bridge-error 观测行不参与 fail-closed，
  // 上游限流期间用最后完整快照继续推荐，并以 sync_warning 暴露降级状态。
  const last = latestRealSync(db, consultant_id);
  const snapshot = latestCompleteSnapshot(db, consultant_id);
  if (!snapshot) {
    return { blocked: true, reason: '无完整快照，先同步', items: [], run_id: null };
  }
  if (!last || !last.complete) {
    return { blocked: true, reason: '本次同步不完整，暂不生成正式推荐',
             sync: last, snapshot_id: snapshot.sync_id, items: [], run_id: null };
  }
  const bridgeErr = latestBridgeError(db, consultant_id, last.completed_at || '');
  const sync_warning = bridgeErr ? {
    at: bridgeErr.started_at,
    ...friendlyBridgeError(bridgeErr.errors), // {message 面向用户, detail 排查原文}
    last_complete_at: snapshot.completed_at || null,
  } : null;

  // 自动桥接的硬间隔：TTC 分页会让 input_hash 每轮变化，若只在哈希相同时节流，
  // 就会每 1–3 分钟生成一次完整推荐。输入变化由下一轮基线吸收；人工重算不受限。
  if (throttle && !dry_run) {
    const lastRun = db.prepare(`SELECT run_id, snapshot_id, created_at
      FROM decision_runs
      WHERE consultant_id=? AND status='COMPLETED'
      ORDER BY created_at DESC LIMIT 1`).get(consultant_id);
    if (lastRun && Date.parse(now()) - Date.parse(lastRun.created_at) < THROTTLE_MS) {
      // A 3-minute bridge used to create 480 skip rows/person/day.  Keep at most
      // one audit marker per hour; the returned result still reports every skip.
      const lastAudit = db.prepare(`SELECT created_at FROM decision_runs
        WHERE consultant_id=? AND status='SKIPPED_THROTTLED'
        ORDER BY created_at DESC LIMIT 1`).get(consultant_id);
      if (!lastAudit || Date.parse(now()) - Date.parse(lastAudit.created_at) >= SKIP_AUDIT_MS) {
        db.prepare(`INSERT INTO decision_runs
          (run_id, consultant_id, snapshot_id, policy_version, candidate_count, status, created_at)
          VALUES (?,?,?,?,?,?,?)`)
          .run(uuid(), consultant_id, snapshot.sync_id, POLICY_VERSION, 0, 'SKIPPED_THROTTLED', now());
      }
      return { skipped: true, reason: '自动推荐距上轮不足 2h，复用上轮', blocked: false,
               run_id: lastRun.run_id, items: null, sync_warning, generated_at: now() };
    }
  }

  // 人工覆盖只作用于当前顾问；同步源 job_facts 保持不变。
  const jobs = effectiveJobs(db, consultant_id);
  const relCtx = relationMap(db, consultant_id);
  const ctx = buildCtx(db, consultant_id, snapshot);

  const evaluated = [];
  let blockedCount = 0;
  for (const job of jobs) {
    const relation = deriveRelation(relCtx, job.project_id);
    const block = hardBlock(job, relation, true);
    if (block) { blockedCount++; continue; }
    const scored = scoreJob(job, relation, ctx);
    const dataConfidence = dataConfidenceOf(job, relation, ctx.now);
    const action = dataConfidence.band === 'INSUFFICIENT' ? 'OBSERVE' : actionOf(scored.score, scored.coverage);
    const presentation = recommendationPresentationOf(job, relation, action, ctx.now, dataConfidence);
    const { reasons, risks, evidence_refs } = explain(job, relation, scored, ctx);
    evaluated.push({
      decision_id: uuid(), project_id: job.project_id, job, relation,
      action,
      score: scored.score, evidence_coverage: scored.coverage,
      confidence_band: { SUFFICIENT: 'HIGH', PARTIAL: 'MEDIUM', INSUFFICIENT: 'LOW' }[dataConfidence.band],
      reasons, risks, evidence_refs: [...evidence_refs, presentationEvidence(presentation)], breakdown: scored.breakdown,
    });
  }
  evaluated.sort(sortRecs);
  evaluated.forEach((r, i) => { r.rank = i + 1; });

  const run_id = uuid();
  if (!dry_run) {
    const insRun = db.prepare(`INSERT INTO decision_runs
      (run_id, consultant_id, snapshot_id, policy_version, candidate_count, status, created_at)
      VALUES (?,?,?,?,?,?,?)`);
    const insRec = db.prepare(`INSERT INTO recommendations
      (decision_id, run_id, project_id, consultant_id, action, score, confidence_band,
       evidence_coverage, reasons_json, risks_json, evidence_refs_json, breakdown_json,
       policy_version, rank, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.exec('BEGIN');
    try {
      insRun.run(run_id, consultant_id, snapshot.sync_id, POLICY_VERSION, evaluated.length, 'COMPLETED', now());
      // 精选盘需要 Top20 之后的替补，但不能把数千候选在每轮全部永久冻结。
      // 默认最多保留 200 条，足够十批替换；candidate_count 仍记录完整评估规模。
      const persisted = evaluated.slice(0, Math.max(top, Number(persistLimit) || PERSIST_LIMIT));
      for (const r of persisted) {
        insRec.run(r.decision_id, run_id, r.project_id, consultant_id, r.action, r.score,
                   r.confidence_band, r.evidence_coverage, JSON.stringify(r.reasons),
                   JSON.stringify(r.risks), JSON.stringify(r.evidence_refs),
                   JSON.stringify(r.breakdown), POLICY_VERSION, r.rank, now());
      }
      pruneRecommendationHistory(db, consultant_id);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  return {
    run_id, blocked: false, snapshot_id: snapshot.sync_id, policy_version: POLICY_VERSION,
    input_stats: { candidates: jobs.length, after_hard_filter: evaluated.length, blocked: blockedCount },
    items: evaluated.slice(0, top).map(publicRec),
    sync_warning, // 降级信号（非阻断）：上游失败时告诉下游「数据在变老」
    generated_at: now(),
  };
}

export const publicRec = (r) => ({
  decision_id: r.decision_id, rank: r.rank, action: r.action,
  score: r.score, confidence_band: r.confidence_band, evidence_coverage: r.evidence_coverage,
  reasons: r.reasons, risks: r.risks, evidence_refs: r.evidence_refs,
  breakdown: r.breakdown,
  job: {
    project_id: r.job.project_id, company: r.job.company, role: r.job.role,
    city: r.job.city, pipeline: r.job.pipeline, hc: r.job.hc,
    active_state: r.job.active_state, priority: r.job.priority ?? null,
    notes: r.job.notes ?? null, company_type: r.job.company_type ?? null,
    current_stage: r.job.current_stage ?? null,
    pipeline_snapshot: r.job.pipeline_snapshot ?? null,
    next_action: r.job.next_action ?? null,
    fact_sources: r.job.fact_sources ?? {},
    fact_updated_at: r.job.fact_updated_at ?? {},
    relation: r.relation, source_url: r.job.source_url,
    captured_at: r.job.captured_at,
  },
});

/** 读最新一轮推荐（工作台默认视图）。raw_json 不出网（原始负载只供库内/回放对照）。
 * 只认 COMPLETED 轮：节流产物的审计行没有冻结推荐，不可当最新轮。 */
export function recommendationRun(db, consultant_id, run_id = null) {
  const run = run_id
    ? db.prepare(`SELECT * FROM decision_runs
      WHERE consultant_id=? AND run_id=? AND status='COMPLETED'`).get(consultant_id, run_id)
    : db.prepare(`SELECT * FROM decision_runs WHERE consultant_id=? AND status='COMPLETED'
      ORDER BY created_at DESC LIMIT 1`).get(consultant_id);
  if (!run) return null;
  const recs = db.prepare(`SELECT * FROM recommendations WHERE run_id=? ORDER BY rank`).all(run.run_id);
  const jobs = effectiveJobs(db, consultant_id);
  const jobMap = Object.fromEntries(jobs.map((j) => [j.project_id, j]));
  const relCtx = relationMap(db, consultant_id);
  return {
    run,
    items: recs.map((r) => ({
      decision_id: r.decision_id, rank: r.rank, action: r.action, score: r.score,
      confidence_band: r.confidence_band, evidence_coverage: r.evidence_coverage,
      reasons: JSON.parse(r.reasons_json), risks: JSON.parse(r.risks_json),
      evidence_refs: JSON.parse(r.evidence_refs_json), breakdown: JSON.parse(r.breakdown_json),
      job: { ...jobMap[r.project_id], raw_json: undefined,
             relation: deriveRelation(relCtx, r.project_id) },
    })),
  };
}

/** 读最新一轮完整推荐。指定历史运行的分页读取使用 recommendationRun。 */
export function latestRun(db, consultant_id) {
  return recommendationRun(db, consultant_id);
}
