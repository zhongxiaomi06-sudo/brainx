/** data-isolation.js — 数据隔离硬约束（2026-08-30 会议点名项）。
 *
 * 纪律：驾驶舱事实只出自 cockpit_facts，职位市场事实只出自 job_facts；
 * source_mode 的唯一权威判定 = cockpit_facts 行存在与否，**绝不因公司名相似升格**——
 * 公司名模糊匹配只能作为「疑似同一客户」线索，不构成驾驶舱上下文。
 *
 * 三个硬约束（违反即降级为待核验，不静默放行）：
 *   ① source_mode 机器可读透出到每个推荐项；
 *   ② 驾驶舱字段（current_stage/pipeline_snapshot/next_action）只能来自 cockpit_facts
 *     （facts.js 的 sourceFact 已实施，本模块提供断言与报告）；
 *   ③ 混入检测常态化：弱归属行、同名重影行进入隔离报告并可告警。
 */
import { now } from './db.js';

export const SOURCE_MODES = { COCKPIT_CONTEXT: '驾驶舱上下文', MARKET_ONLY: '职位市场' };

/** 唯一权威判定：有 cockpit_facts 行 → COCKPIT_CONTEXT，否则 MARKET_ONLY。 */
export function sourceModeOf(db, project_id) {
  const row = db.prepare(`SELECT membership_status FROM cockpit_facts
    WHERE project_id=?`).get(project_id);
  return row ? { source_mode: 'COCKPIT_CONTEXT', membership_status: row.membership_status }
             : { source_mode: 'MARKET_ONLY', membership_status: null };
}

/** 批量判定（页面/列表路径用，一次 IN 查询）。 */
export function sourceModeMap(db, projectIds) {
  if (!projectIds.length) return {};
  const marks = new Set(db.prepare(`SELECT project_id FROM cockpit_facts
    WHERE project_id IN (${projectIds.map(() => '?').join(',')})`).all(...projectIds)
    .map((r) => r.project_id));
  return Object.fromEntries(projectIds.map((pid) => [
    pid,
    marks.has(pid)
      ? { source_mode: 'COCKPIT_CONTEXT',
          membership_status: db.prepare(`SELECT membership_status FROM cockpit_facts
            WHERE project_id=?`).get(pid)?.membership_status || null }
      : { source_mode: 'MARKET_ONLY', membership_status: null },
  ]));
}

/** 隔离体检报告：规模、弱归属、同名重影（同公司分属两源且无 cockpit 行的市场职位）。 */
export function isolationReport(db) {
  const cockpitCount = db.prepare('SELECT COUNT(*) n FROM cockpit_facts').get().n;
  const weakOwnership = db.prepare(`SELECT project_id FROM cockpit_facts
    WHERE membership_status='UNCONFIRMED'`).all();
  // 同名重影：cockpit 职位与「无 cockpit 行」的市场职位同公司（项目可能重复建档）
  const shadowPairs = db.prepare(`SELECT j.project_id AS market_pid, c.project_id AS cockpit_pid,
      j.company FROM job_facts j
    JOIN job_facts c ON c.company = j.company AND c.project_id != j.project_id
    JOIN cockpit_facts cf ON cf.project_id = c.project_id
    WHERE NOT EXISTS (SELECT 1 FROM cockpit_facts x WHERE x.project_id = j.project_id)
    ORDER BY j.company LIMIT 50`).all();
  const marketCount = db.prepare(`SELECT COUNT(*) n FROM job_facts j
    WHERE NOT EXISTS (SELECT 1 FROM cockpit_facts x WHERE x.project_id = j.project_id)`).get().n;
  return {
    generated_at: now(),
    totals: { cockpit_context: cockpitCount, market_only: marketCount },
    weak_ownership: { count: weakOwnership.length, project_ids: weakOwnership.map((r) => r.project_id).slice(0, 50) },
    same_company_shadow: { count: shadowPairs.length, pairs: shadowPairs },
    discipline: '驾驶舱事实只出 cockpit_facts；source_mode 唯一权威=cockpit_facts 行存在；公司名相似不升格',
  };
}
