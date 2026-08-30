/** 工作台首屏模型(与 Web 首屏同源;严格隔离:恒为会话 cid,忽略外来 consultant_id)。 */
import { latestSync } from '../../sync.js';
import { latestRun } from '../../recommend.js';
import { commitmentSummary } from '../../engagement.js';

export default {
  name: 'brainx_workbench',
  description: '当前顾问的工作台:同步状态/承接摘要(关注数、承接数、待行动数)/今日 Top3 推荐/run_id。只能查本人。',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) => {
    const { db, cid } = ctx;
    const sync = latestSync(db, cid);
    const run = latestRun(db, cid, { hideEngaged: true });
    const c = commitmentSummary(db, cid);
    return {
      consultant_id: cid,
      sync: sync ? { state: sync.complete ? 'READY' : 'INCOMPLETE', updated_at: sync.completed_at,
                     rows_read: sync.rows_read, rows_expected: sync.rows_expected,
                     errors: JSON.parse(sync.errors || '[]') } : { state: 'EMPTY' },
      current_policy_version: run?.run?.policy_version || null,
      watched_count: c.watched_count, watched_limit: c.watched_limit,
      accepted_count: c.accepted_count, need_action_count: c.need_action_count,
      commitments: c.items, today_top3: run ? run.items.slice(0, 3) : [],
      run_id: run?.run?.run_id || null,
    };
  },
};
