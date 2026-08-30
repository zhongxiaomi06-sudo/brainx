/** 最近一轮推荐(冻结行;同步不完整时 blocked;严格隔离:恒为会话 cid)。 */
import { latestSync } from '../../sync.js';
import { latestRun } from '../../recommend.js';

export default {
  name: 'brainx_recommendations',
  description: '当前顾问最近一轮推荐榜(冻结行,含评分/理由/风险/置信度)。同步不完整时返回 blocked。只能查本人。',
  parameters: { type: 'object', properties: {
    limit: { type: 'number', description: '返回条数,默认 10,上限 50' } } },
  run: ({ limit = 10 }, ctx) => {
    const { db, cid } = ctx;
    const sync = latestSync(db, cid);
    const run = latestRun(db, cid, { hideEngaged: true });
    if (sync && !sync.complete) return { blocked: true, reason: '本次同步不完整,为避免误导,暂不生成正式推荐', items: [] };
    if (!run) return { blocked: false, empty: true, items: [] };
    return { blocked: false, run_id: run.run.run_id, policy_version: run.run.policy_version,
             generated_at: run.run.created_at, items: run.items.slice(0, Math.min(limit, 50)) };
  },
};
