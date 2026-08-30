import { currentStateMap, legalActionsForState } from './engagement.js';
import { latestRun, recommendationRun } from './recommend.js';
import { presentationForRecommendation } from './recommendation-presentation.js';
import { latestRealSync } from './sync.js';

export const RECOMMENDATION_PAGE_SIZE = 20;
export const RECOMMENDATION_SORTS = ['priority', 'activity', 'recent', 'confidence', 'exploration'];

function normalizeSearch(value) {
  return String(value || '').trim().normalize('NFKC').toLocaleLowerCase('zh-CN').slice(0, 120);
}

function cleanJobDescription(value) {
  return String(value || '').replace(/<!--[\s\S]*?-->/g, ' ');
}

function matchesSearch(item, search) {
  if (!search) return true;
  const job = item.job || {};
  const searchable = [job.role, job.company, job.city, cleanJobDescription(job.notes)]
    .filter(Boolean).join('\n').normalize('NFKC').toLocaleLowerCase('zh-CN');
  return search.split(/\s+/).every((term) => searchable.includes(term));
}

function normalizeSort(value) {
  const sort = String(value || 'priority').trim().toLowerCase();
  return RECOMMENDATION_SORTS.includes(sort) ? sort : null;
}

function encodeCursor(runId, afterRank, afterValue, search, sort) {
  return Buffer.from(JSON.stringify({
    version: 3, run_id: runId, after_rank: afterRank, after_value: afterValue, search, sort,
  }))
    .toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (![1, 2, 3].includes(parsed?.version) || typeof parsed.run_id !== 'string'
        || !Number.isInteger(parsed.after_rank) || parsed.after_rank < 0) return null;
    if (parsed.version < 3) {
      return { ...parsed, search: parsed.version === 2 ? normalizeSearch(parsed.search) : '',
        sort: 'priority', after_value: parsed.after_rank };
    }
    const sort = normalizeSort(parsed.sort);
    if (!sort || (sort === 'recent' && parsed.after_value !== null && typeof parsed.after_value !== 'string')
        || (sort === 'confidence' && !Number.isInteger(parsed.after_value))
        || (['activity', 'exploration'].includes(sort) && parsed.after_value !== null
          && typeof parsed.after_value !== 'number')) return null;
    return { ...parsed, search: normalizeSearch(parsed.search), sort };
  } catch {
    return null;
  }
}

function sortValue(entry, sort) {
  if (sort === 'recent') return entry.presentation.recent_activity?.occurred_at || null;
  if (sort === 'confidence') {
    return { SUFFICIENT: 0, PARTIAL: 1, INSUFFICIENT: 2 }[entry.presentation.data_confidence.band] ?? 3;
  }
  if (sort === 'activity') {
    return entry.item.breakdown?.find((dimension) => dimension.dim === 'activity')?.score ?? null;
  }
  if (sort === 'exploration') {
    return entry.item.breakdown?.find((dimension) => dimension.dim === 'exploration')?.score ?? null;
  }
  return entry.item.rank;
}

function compareSortKeys(leftValue, leftRank, rightValue, rightRank, sort) {
  if (sort === 'priority') return leftRank - rightRank;
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue === null) return -1;
  if (leftValue !== rightValue) {
    if (sort === 'recent') return String(rightValue).localeCompare(String(leftValue));
    if (sort === 'confidence') return Number(leftValue) - Number(rightValue);
    return Number(rightValue) - Number(leftValue);
  }
  return sort === 'exploration' ? rightRank - leftRank : leftRank - rightRank;
}

function compareEntries(left, right, sort) {
  return compareSortKeys(sortValue(left, sort), left.item.rank, sortValue(right, sort), right.item.rank, sort);
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
    sort: 'priority',
    next_cursor: null,
    new_run_available: false,
    items: [],
    ...extra,
  };
}

/**
 * 读取同一冻结运行内的一页。游标携带 run_id、排序条件与上一条稳定排序键，
 * 避免新运行或“暂不考虑”导致偏移量漂移、重复或遗漏。
 */
export function recommendationPage(db, consultantId, { cursor = null, search = '', sort = 'priority' } = {}) {
  const normalizedSearch = normalizeSearch(search);
  const normalizedSort = normalizeSort(sort);
  if (!normalizedSort) {
    return { ok: false, status: 400, code: 'INVALID_RECOMMENDATION_SORT', message: '推荐排序方式无效' };
  }
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (cursor && !decoded) {
    return { ok: false, status: 400, code: 'INVALID_RECOMMENDATION_CURSOR', message: '推荐页游标无效，请刷新队列' };
  }
  if (decoded && decoded.search !== normalizedSearch) {
    return { ok: false, status: 400, code: 'INVALID_RECOMMENDATION_CURSOR', message: '搜索条件已变化，请从第一页重新搜索' };
  }
  if (decoded && decoded.sort !== normalizedSort) {
    return { ok: false, status: 400, code: 'INVALID_RECOMMENDATION_CURSOR', message: '排序方式已变化，请从第一页重新查看' };
  }

  if (!decoded) {
    const sync = latestRealSync(db, consultantId);
    if (sync && !sync.complete) {
      return emptyPage({ blocked: true, reason: '本次同步不完整，为避免误导，暂不生成正式推荐',
        sort: normalizedSort });
    }
  }

  const selected = decoded
    ? recommendationRun(db, consultantId, decoded.run_id)
    : latestRun(db, consultantId);
  if (!selected) {
    if (decoded) {
      return { ok: false, status: 409, code: 'RECOMMENDATION_RUN_EXPIRED', message: '原推荐队列已不可用，请刷新到最新一轮' };
    }
    return emptyPage({ empty: true, sort: normalizedSort });
  }

  const hidden = new Set(db.prepare(`SELECT project_id FROM recommendation_feedback
    WHERE consultant_id=?`).all(consultantId).map((row) => row.project_id));
  const visible = selected.items
    .filter((item) => !hidden.has(item.job.project_id))
    .filter((item) => matchesSearch(item, normalizedSearch))
    .map((item) => ({ item, presentation: presentationForRecommendation(item, selected.run.created_at) }))
    .sort((left, right) => compareEntries(left, right, normalizedSort));
  const remaining = decoded ? visible.filter((entry) => compareSortKeys(
    sortValue(entry, normalizedSort), entry.item.rank, decoded.after_value, decoded.after_rank, normalizedSort,
  ) > 0) : visible;
  const entries = remaining.slice(0, RECOMMENDATION_PAGE_SIZE);
  const last = entries.at(-1) || null;
  const hasMore = remaining.length > entries.length;
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
    sort: normalizedSort,
    next_cursor: hasMore && last ? encodeCursor(
      selected.run.run_id, last.item.rank, sortValue(last, normalizedSort), normalizedSearch, normalizedSort,
    ) : null,
    new_run_available: latestRunId !== selected.run.run_id,
    items: entries.map(({ item, presentation }) => {
      const state = states.get(item.job.project_id)?.state || 'NEW';
      const risks = presentation.data_confidence.primary_risk
        ? [presentation.data_confidence.primary_risk, ...item.risks.filter((risk) => risk !== presentation.data_confidence.primary_risk)]
        : item.risks;
      return {
        ...item, risks,
        decision_tier: presentation.decision_tier,
        decision_tier_reason: presentation.decision_tier_reason,
        data_confidence: presentation.data_confidence,
        recent_activity: presentation.recent_activity,
        presentation_version: presentation.version,
        presentation_source: presentation.source,
        engagement_state: state,
        legal_actions: legalActionsForState(state),
      };
    }),
  };
}
