/** 客户公司聚合(按公司汇总在库职位/活跃/HC/最近动态)。 */
import { clientRows } from '../../radar.js';

export default {
  name: 'brainx_clients',
  description: '客户洞察:按公司聚合当前顾问可见职位(job_count/active_jobs/hc_known/last_activity/relations)。问"某客户公司情况"时用。',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) => clientRows(ctx.db, ctx.cid),
};
