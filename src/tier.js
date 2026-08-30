/** tier.js — 曝光埋点（算法文档 §2.4/§3.4）。行动分层见 recommendation-presentation.js。
 *
 * 行动层级（前端展示口径，文档 5.1）：不用假精确概率，只表达同批相对优先级：
 *   TODAY（今天推进）：事实充分、需求紧迫、顾问匹配（action=RECOMMEND_ACCEPT 且非低置信）；
 *   WATCH（本周观察）：有价值但紧迫度/证据略弱（RECOMMEND_WATCH 或置信中）；
 *   VERIFY（待核验）：关键事实缺失/陈旧/冲突（coverage<0.5 或 LOW 置信）；
 *   EXCLUDE（暂不推荐）：资格不满足或当前价值明显较低（OBSERVE 且 LOW 分）。
 *
 * 曝光埋点：冻结时按 rank 记录展示位置与展示概率（§2.4 可重放要求）；
 * 探索位 propensity=ε（BRAINX_EXPLORATION_EPSILON，默认 0.1），正常位=1。
 * 未展示不等于负反馈（§2.5）：served_at 为 NULL 的行永远不进负反馈统计。
 */
import { now, uuid } from './db.js';

/** 冻结时写曝光（与 recommendations 同事务调用）。探索位口径（§3.4：每 Top10 约 1 位）：
 * 展示窗口内按 breakdown.exploration 降序取前 ceil(top×ε) 个 OBSERVE 条目为探索位，
 * 其余记 NORMAL——无探索打分的算法不会把大批 OBSERVE 误标为探索。 */
export function writeImpressions(db, { run_id, consultant_id, items, top, policy_version }) {
  const eps = Number(process.env.BRAINX_EXPLORATION_EPSILON) > 0
    ? Number(process.env.BRAINX_EXPLORATION_EPSILON) : 0.1;
  const ins = db.prepare(`INSERT OR IGNORE INTO recommendation_impressions
    (impression_id, run_id, decision_id, consultant_id, project_id, rank, slot_kind,
     propensity, policy_version, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const at = now();
  const window = items.filter((r) => r.rank <= top);
  const exploreSlots = Math.max(1, Math.round(top * eps));
  const explorePids = new Set(window.filter((r) => r.action === 'OBSERVE')
    .sort((a, b) => (b.breakdown?.exploration ?? 0) - (a.breakdown?.exploration ?? 0))
    .slice(0, exploreSlots).map((r) => r.project_id));
  for (const r of window) {
    const exploration = explorePids.has(r.project_id);
    ins.run(`imp_${uuid()}`, run_id, r.decision_id, consultant_id, r.project_id, r.rank,
            exploration ? 'EXPLORATION' : 'NORMAL', exploration ? eps : 1.0, policy_version, at);
  }
}

/** 列表接口真实下发时回填 served_at（幂等：只补 NULL）。 */
export function markServed(db, { run_id, consultant_id, project_ids }) {
  if (!project_ids?.length) return;
  const upd = db.prepare(`UPDATE recommendation_impressions SET served_at=?
    WHERE run_id=? AND consultant_id=? AND project_id=? AND served_at IS NULL`);
  for (const pid of project_ids) upd.run(now(), run_id, consultant_id, pid);
}
