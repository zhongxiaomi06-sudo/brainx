import { currentStateMap, legalActionsForState } from './engagement.js';
import { latestRun, recommendationRun } from './recommend.js';
import { latestRealSync } from './sync.js';

export const RECOMMENDATION_PAGE_SIZE = 20;

function encodeCursor(runId, afterRank) {
  return Buffer.from(JSON.stringify({ version: 1, run_id: runId, after_rank: afterRank }))
    .toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (parsed?.version !== 1 || typeof parsed.run_id !== 'string'
        || !Number.isInteger(parsed.after_rank) || parsed.after_rank < 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

function emptyPage(extra = {}) {
  return {
    blocked: false,
    run_id: null,
    snapshot_id: null,
    policy_version: null,
    generated_at: null,
    evaluated_count: 0,
    total_count: 0,
    page_size: RECOMMENDATION_PAGE_SIZE,
    next_cursor: null,
    new_run_available: false,
    items: [],
    ...extra,
  };
}

/**
 * 读取同一冻结运行内的一页。游标同时携带 run_id 与最后 rank，避免新运行或
 * “暂不考虑”导致偏移量漂移、重复或遗漏。
 */
export function recommendationPage(db, consultantId, { cursor = null } = {}) {
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (cursor && !decoded) {
    return { ok: false, status: 400, code: 'INVALID_RECOMMENDATION_CURSOR', message: '推荐页游标无效，请刷新队列' };
  }

  if (!decoded) {
    const sync = latestRealSync(db, consultantId);
    if (sync && !sync.complete) {
      return emptyPage({ blocked: true, reason: '本次同步不完整，为避免误导，暂不生成正式推荐' });
    }
  }

  const selected = decoded
    ? recommendationRun(db, consultantId, decoded.run_id)
    : latestRun(db, consultantId);
  if (!selected) {
    if (decoded) {
      return { ok: false, status: 409, code: 'RECOMMENDATION_RUN_EXPIRED', message: '原推荐队列已不可用，请刷新到最新一轮' };
    }
    return emptyPage({ empty: true });
  }

  const hidden = new Set(db.prepare(`SELECT project_id FROM recommendation_feedback
    WHERE consultant_id=?`).all(consultantId).map((row) => row.project_id));
  const visible = selected.items.filter((item) => !hidden.has(item.job.project_id));
  const afterRank = decoded?.after_rank || 0;
  const items = visible.filter((item) => item.rank > afterRank).slice(0, RECOMMENDATION_PAGE_SIZE);
  const lastRank = items.at(-1)?.rank || afterRank;
  const hasMore = visible.some((item) => item.rank > lastRank);
  const states = currentStateMap(db, consultantId);
  const latestRunId = db.prepare(`SELECT run_id FROM decision_runs
    WHERE consultant_id=? AND status='COMPLETED'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(consultantId)?.run_id || null;

  return {
    blocked: false,
    run_id: selected.run.run_id,
    snapshot_id: selected.run.snapshot_id,
    policy_version: selected.run.policy_version,
    generated_at: selected.run.created_at,
    evaluated_count: selected.run.candidate_count,
    total_count: visible.length,
    page_size: RECOMMENDATION_PAGE_SIZE,
    next_cursor: hasMore ? encodeCursor(selected.run.run_id, lastRank) : null,
    new_run_available: latestRunId !== selected.run.run_id,
    items: items.map((item) => {
      const state = states.get(item.job.project_id)?.state || 'NEW';
      return { ...item, engagement_state: state, legal_actions: legalActionsForState(state) };
    }),
  };
}
