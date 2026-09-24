/** Algorithm A 的只读展示投影：只读 LIVE，保持 Agent 原 rank，不产生分数。 */
import { currentStateMap, legalActionsForState } from '../engagement.js';
import { effectiveJob } from '../facts.js';
import { ignoredProjectIds } from '../opportunity-ignore.js';
import { sourceModeMap } from '../data-isolation.js';
import { jobVisibleTo } from '../visibility.js';

export const AGENTIC_PRESENTATION_ENGINE = 'agentic-ranking-v1';
export const AGENTIC_PAGE_SIZE = 20;

const normalizeSearch = (value) => String(value || '').trim().normalize('NFKC')
  .toLocaleLowerCase('zh-CN').slice(0, 120);

function encodeCursor(runId, afterRank, search) {
  return Buffer.from(JSON.stringify({ version: 1, engine: AGENTIC_PRESENTATION_ENGINE,
    run_id: runId, after_rank: afterRank, search })).toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const out = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (out?.version !== 1 || out.engine !== AGENTIC_PRESENTATION_ENGINE
      || typeof out.run_id !== 'string' || !Number.isInteger(out.after_rank)
      || out.after_rank < 0 || typeof out.search !== 'string') return null;
    return { ...out, search: normalizeSearch(out.search) };
  } catch { return null; }
}

function parse(value, fallback) {
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function matches(job, search) {
  if (!search) return true;
  const text = [job.role, job.company, job.city, job.notes].filter(Boolean).join('\n')
    .normalize('NFKC').toLocaleLowerCase('zh-CN');
  return search.split(/\s+/).every((term) => text.includes(term));
}

function empty(state, extra = {}) {
  return {
    engine: AGENTIC_PRESENTATION_ENGINE, state, blocked: false, run_id: null,
    snapshot_id: null, policy_version: AGENTIC_PRESENTATION_ENGINE, generated_at: null,
    evaluated_count: 0, original_total_count: 0, total_count: 0,
    page_size: AGENTIC_PAGE_SIZE, sort: 'priority', next_cursor: null,
    new_run_available: false, latest_status: null, items: [], ...extra,
  };
}

function runById(db, consultantId, runId) {
  return db.prepare(`SELECT * FROM agentic_ranking_runs
    WHERE tenant_id='brainx' AND consultant_id=? AND run_id=? AND run_mode='LIVE'`)
    .get(consultantId, runId);
}

function latestRuns(db, consultantId) {
  const rows = db.prepare(`SELECT * FROM agentic_ranking_runs
    WHERE tenant_id='brainx' AND consultant_id=? AND run_mode='LIVE'
    ORDER BY generation DESC LIMIT 100`).all(consultantId);
  return { latest: rows[0] || null,
    published: rows.find((row) => row.status === 'PUBLISHED') || null };
}

function nonPublishedPage(run) {
  if (!run) return empty('EMPTY', { empty: true });
  if (['RUNNING', 'VALIDATING'].includes(run.status)) {
    return empty('GENERATING', { run_id: run.run_id, generated_at: run.created_at,
      latest_status: run.status });
  }
  if (run.status === 'ABSTAINED') {
    const output = parse(run.output_json, {});
    return empty('ABSTAINED', { run_id: run.run_id, snapshot_id: run.source_snapshot_id,
      generated_at: run.finished_at || run.created_at, evaluated_count: run.retrieved_count,
      latest_status: run.status, empty: true, reason: output.stop_reason || 'ABSTAINED',
      missing_information: output.missing_information || [] });
  }
  return empty('FAILED', { run_id: run.run_id, snapshot_id: run.source_snapshot_id,
    generated_at: run.finished_at || run.created_at, evaluated_count: run.retrieved_count,
    latest_status: run.status, failure_code: run.failure_code || run.status });
}

function visibleRows(db, consultantId, run, search) {
  const ignored = ignoredProjectIds(db, consultantId);
  const accepted = new Set(db.prepare(`SELECT project_id FROM current_engagement
    WHERE consultant_id=? AND state='ACCEPTED'`).all(consultantId).map((row) => row.project_id));
  return db.prepare(`SELECT * FROM agentic_ranking_items WHERE run_id=? ORDER BY rank`)
    .all(run.run_id).flatMap((row) => {
      const job = effectiveJob(db, consultantId, row.job_id);
      if (!job || job.active_state !== 'OPEN' || job.hc === 0
        || ignored.has(row.job_id) || accepted.has(row.job_id)
        || !jobVisibleTo(db, consultantId, row.job_id) || !matches(job, search)) return [];
      return [{ row, job }];
    });
}

/** 返回已冻结 A run 的安全展示页；错误对象由 HTTP 层映射。 */
export function agenticRecommendationPage(db, consultantId, {
  cursor = null, search = '', sort = 'priority', pageSize = AGENTIC_PAGE_SIZE,
} = {}) {
  if (sort !== 'priority') return { ok: false, status: 400,
    code: 'AGENTIC_ORDER_IMMUTABLE', message: 'Algorithm A 只按 Agent 原序展示' };
  const normalizedSearch = normalizeSearch(search);
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (cursor && !decoded) return { ok: false, status: 400,
    code: 'INVALID_RECOMMENDATION_CURSOR', message: '推荐页游标无效，请刷新队列' };
  if (decoded && decoded.search !== normalizedSearch) return { ok: false, status: 400,
    code: 'INVALID_RECOMMENDATION_CURSOR', message: '搜索条件已变化，请从第一页重新搜索' };
  const size = Number.isInteger(pageSize) ? Math.max(1, Math.min(AGENTIC_PAGE_SIZE, pageSize))
    : AGENTIC_PAGE_SIZE;
  const { latest, published } = latestRuns(db, consultantId);
  const selected = decoded ? runById(db, consultantId, decoded.run_id) : published;
  if (decoded && selected?.status !== 'PUBLISHED') return { ok: false, status: 409,
    code: 'RECOMMENDATION_RUN_EXPIRED', message: '原推荐队列已不可用，请刷新到最新一轮' };
  if (!selected) return nonPublishedPage(latest);

  const visible = visibleRows(db, consultantId, selected, normalizedSearch);
  const remaining = decoded ? visible.filter(({ row }) => row.rank > decoded.after_rank) : visible;
  const entries = remaining.slice(0, size);
  const last = entries.at(-1);
  const sourceModes = sourceModeMap(db, entries.map(({ row }) => row.job_id));
  const states = currentStateMap(db, consultantId);
  const originalCount = db.prepare(`SELECT COUNT(*) n FROM agentic_ranking_items WHERE run_id=?`)
    .get(selected.run_id).n;
  const previous = latest && latest.run_id !== selected.run_id;
  return {
    engine: AGENTIC_PRESENTATION_ENGINE,
    state: previous ? 'PREVIOUS_RESULT' : 'READY', blocked: false,
    run_id: selected.run_id, snapshot_id: selected.source_snapshot_id,
    policy_version: selected.algorithm_version, generated_at: selected.finished_at || selected.created_at,
    evaluated_count: selected.retrieved_count, original_total_count: originalCount,
    total_count: visible.length, page_size: size, sort: 'priority',
    next_cursor: remaining.length > entries.length && last
      ? encodeCursor(selected.run_id, last.row.rank, normalizedSearch) : null,
    new_run_available: !!previous, latest_status: latest?.status || selected.status,
    items: entries.map(({ row, job }) => {
      const state = states.get(row.job_id)?.state || 'NEW';
      return {
        engine: AGENTIC_PRESENTATION_ENGINE, run_id: row.run_id,
        decision_id: row.decision_id, rank: row.rank, decision_tier: row.decision_tier,
        reason_codes: parse(row.reason_codes_json, []), reason: row.reason,
        tradeoff: row.tradeoff, evidence_refs: parse(row.evidence_refs_json, []),
        uncertainties: parse(row.uncertainties_json, []),
        suggested_next_action: row.suggested_next_action,
        generated_at: selected.finished_at || selected.created_at, job,
        source_mode: sourceModes[row.job_id]?.source_mode || 'MARKET_ONLY',
        membership_status: sourceModes[row.job_id]?.membership_status || null,
        engagement_state: state, legal_actions: legalActionsForState(state),
      };
    }),
  };
}
