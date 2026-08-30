/** labels.js — 0–5 级业务结果标签（算法文档 §4）。
 *
 * 训练目标不以点击为终点，以真实业务漏斗为主。映射（取最高可达级）：
 *   0 明确不感兴趣/关闭/不匹配：DISMISSED / ×反馈 / 终局关闭（人工动作或原因码）
 *   1 关注/查看后持续跟进：WATCHED（真实展示后的有效互动）
 *   2 加入项目/开始跟进：ACCEPTED（归属+目标+第一行动+截止）
 *   3 产出有效候选人或完成推荐：outcomes stage ∈ {推荐采纳, 推荐}
 *   4 进入面试：outcomes stage ∈ {面试, 客户面试}
 *   5 Offer/入职/开票：outcomes stage ∈ {Offer, 入职, 开票} / 终局入职
 * 纪律（§4）：未展示（impressions.served_at IS NULL 且无互动）保持「未知」(null)，
 * 绝不标记为 0；同一 顾问×推荐批次 作为排序组。
 */
import { now } from './db.js';

const STAGE3 = ['推荐采纳', '推荐'];
const STAGE4 = ['面试', '客户面试'];
const STAGE5 = ['Offer', 'offer', '入职', '开票'];

/** 单职位标签（0-5；无足够证据返回 null=未知）。 */
export function labelFor(db, consultant_id, project_id) {
  // 5/4/3 以权威结果事实优先
  const stages = db.prepare(`SELECT stage FROM job_outcomes
    WHERE consultant_id=? AND project_id=?`).all(consultant_id, project_id).map((r) => r.stage);
  if (stages.some((s) => STAGE5.includes(s))) return 5;
  if (stages.some((s) => STAGE4.includes(s))) return 4;
  if (stages.some((s) => STAGE3.includes(s))) return 3;
  const state = db.prepare(`SELECT state FROM current_engagement
    WHERE consultant_id=? AND project_id=?`).get(consultant_id, project_id)?.state;
  if (state === 'ACCEPTED' || state === 'COMPLETED') return 2;
  if (state === 'DISMISSED') return 0;
  const negFeedback = db.prepare(`SELECT 1 FROM recommendation_feedback
    WHERE consultant_id=? AND project_id=? LIMIT 1`).get(consultant_id, project_id);
  if (negFeedback) return 0;
  if (state === 'WATCHED') return 1;
  return null; // 未知：未展示/未互动，按纪律不打标
}

/** 一个排序组（顾问 × run）的 (rank, label) 序列，供 Recall/NDCG 评估。 */
export function labelsForRun(db, consultant_id, run_id) {
  const recs = db.prepare(`SELECT project_id, rank FROM recommendations
    WHERE run_id=? AND consultant_id=? ORDER BY rank`).all(run_id, consultant_id);
  return recs.map((r) => ({ project_id: r.project_id, rank: r.rank,
                            label: labelFor(db, consultant_id, r.project_id) }));
}

/** 训练样本导出（行=曝光×标签；只含已展示或已互动，遵守「未展示=未知」）。 */
export function exportTrainingRows(db, consultant_id, { since = null } = {}) {
  const rows = db.prepare(`SELECT i.run_id, i.project_id, i.rank, i.slot_kind, i.propensity,
      i.policy_version, i.served_at, i.created_at
    FROM recommendation_impressions i
    WHERE i.consultant_id=? ${since ? 'AND i.created_at >= ?' : ''}
    ORDER BY i.created_at DESC, i.rank`)
    .all(...(since ? [consultant_id, since] : [consultant_id]));
  return rows.map((r) => ({ ...r, label: labelFor(db, consultant_id, r.project_id),
                            exported_at: now() }));
}
