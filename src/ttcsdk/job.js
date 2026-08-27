/** ttcsdk/job.js — 职位域 API（ATS 真 project_id / HC / Pipeline 的源头）。 */
import { TtcApiError, ttcRequest } from './http.js';

/** 职位检索（POST search，单页）。返回该 JWT 持有者权限视图内的职位。 */
export const search = (jwt, query = {}, fetchImpl) =>
  ttcRequest(jwt, 'POST', '/api/crm/v1/job/search', { page: 1, ...query }, fetchImpl);

/** 全量拉取（cursor 分页，实测每页固定 10 条）。maxPages 防失控；达到上限仍有下一页时明确失败。
 * paceMs：页间节流（2026-08-25 限流根治）——91 页连发是典型的租户级限流触发器，
 * 生产桥接传 120ms 把单顾问全量拉取摊到 ~11s；CLI/测试默认 0 不节流。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const incomplete = (reason) => new TtcApiError(`ttc 分页未完成：${reason}`, { code: 'TTC_PAGINATION_INCOMPLETE' });
export async function searchAll(jwt, query = {}, fetchImpl, { paceMs = 0, maxPages = 100 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages 必须是正整数');
  const { cursor: initialCursor = '', ...filters } = query || {};
  const out = [];
  let cursor = String(initialCursor || '');
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && paceMs > 0) await sleep(paceMs);
    const d = await ttcRequest(jwt, 'POST', '/api/crm/v1/job/search',
      { page: 1, ...filters, ...(cursor ? { cursor } : {}) }, fetchImpl);
    const jobs = d?.jobs || [];
    out.push(...jobs);
    if (!d?.has_more) return out;
    const nextCursor = String(d?.cursor || '').trim();
    if (!nextCursor) throw incomplete(`第 ${p + 1} 页声明 has_more，但没有返回 cursor`);
    if (nextCursor === cursor) throw incomplete(`第 ${p + 1} 页 cursor 未前进`);
    cursor = nextCursor;
  }
  throw incomplete(`达到 ${maxPages} 页安全上限，仍有下一页`);
}

/** 增量拉取（2026-08-25 限流根治第二阶段）：职位按 update_time 降序返回（实测），
 * 翻到「整页都不新于 sinceMs」即提前停——日常同步从 ~91 页降到 1-3 页。
 * 返回 { jobs, complete }；中途限流时带上已抓到的新前缀返回 complete=false
 * （降序保证前缀是最新数据，可安全入库；sinceMs 不前进，下轮自然补齐）。 */
export async function searchSince(jwt, { sinceMs = 0, paceMs = 0, maxPages = 100, query = {} } = {}, fetchImpl) {
  const out = [];
  let cursor = '';
  let complete = true;
  for (let p = 0; p < maxPages; p++) {
    if (p > 0 && paceMs > 0) await sleep(paceMs);
    let d;
    try {
      d = await ttcRequest(jwt, 'POST', '/api/crm/v1/job/search',
        { page: 1, ...(cursor ? { cursor } : {}), ...query }, fetchImpl);
    } catch (e) {
      if (out.length) { complete = false; break; } // 限流/网络中断：保住新前缀
      throw e;
    }
    const jobs = d?.jobs || [];
    // 缺 update_time 的异常行当新鲜处理（宁可多拉一页，不提前截断）
    const tsOf = (j) => {
  const t = Number(j.update_time);
  // 脏值（非数字）按 Infinity 兜底：NaN 会让该行被判「不新」，
  // 既丢行又触发 fresh.length<jobs.length 提前停，单行脏数据截断整轮增量。
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};
    const fresh = sinceMs > 0 ? jobs.filter((j) => tsOf(j) > sinceMs) : jobs;
    out.push(...fresh);
    // 整页都不新（降序序列 → 后续页更老）→ 提前停；fresh < jobs 说明本页触达水位
    if (sinceMs > 0 && jobs.length && fresh.length < jobs.length) return { jobs: out, complete: true };
    if (!d?.has_more) return { jobs: out, complete: true };
    const nextCursor = String(d?.cursor || '').trim();
    if (!nextCursor) throw incomplete(`第 ${p + 1} 页声明 has_more，但没有返回 cursor`);
    if (nextCursor === cursor) throw incomplete(`第 ${p + 1} 页 cursor 未前进`);
    cursor = nextCursor;
  }
  return { jobs: out, complete };
}

/** TTC job → runSync payload 行（2026-08-14 实测字段驱动）。
 * need_blur=1 的公司用面向候选人名（company_name_for_c），守脱敏纪律。
 * status：1=OPEN（实测 tags 新职位/活跃）；0=COOLING；其余 UNKNOWN。
 * relation=null（桥接纪律）——主做归属走 owner_name，由 relations.js 推导。 */
export function toJobRow(j) {
  const blurred = j.need_blur === 1 || j.need_blur === true;
  const company = (blurred && j.company_name_for_c) ? j.company_name_for_c : (j.company_name || '');
  const steps = j.pipeline_info?.pipeline_step_count || {};
  const pipe = Object.entries(steps).map(([k, v]) => `${k}×${v}`).join(' ');
  return {
    project_id: j.unique_id,              // 真 ATS project_id（替换 P-FIX 占位）
    company, role: j.name || '职位待定',
    city: (j.cities || []).join('、') || null,
    pipeline: pipe || null,               // 真 Pipeline（"Sourcing×1 二面×2" 摘要）
    hc: j.head_count ?? null,             // 真 HC
    active_state: j.status === 1 ? 'OPEN' : j.status === 0 ? 'COOLING' : 'UNKNOWN',
    priority: null,                       // TTC priority 字段实测恒 0，无信号
    notes: j.analytics || j.description || null,
    company_type: null,                   // industry_tags 形态未稳定，暂不映射（raw_json 有全量）
    owner_name: j.managers?.[0]?.name || null,
    owner_unique_id: j.managers?.[0]?.unique_id || null,
    chat_id: j.group_chat?.id || null,      // 驾驶舱群（活跃判定数据源；一群可挂多职位）
    relation: null,
    source_url: `ttc://job/${j.unique_id}`,
    captured_at: j.update_time ? new Date(Number(j.update_time)).toISOString() : undefined,
    ttc: { company_unique_id: j.company_unique_id, cooperation: j.cooperation || '',
           status_tags: j.status_tags || [], group_chat_id: j.group_chat?.id || '',
           participants: (j.participants || []).map((p) => p.name) },
  };
}
