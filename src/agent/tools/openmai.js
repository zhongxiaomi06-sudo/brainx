/** OpenMai 找人结果(接单后自动找人任务的状态与结果 markdown)。 */
import { getOpenmaiResult } from '../../openmai-task.js';
import { jobVisibleTo } from '../../visibility.js';

export default {
  name: 'brainx_openmai_result',
  description: '某职位 OpenMai 自动找人任务的状态(running/done/failed)与结果(候选人推荐 markdown)。仅本人承接职位可见。',
  parameters: { type: 'object', required: ['project_id'], properties: {
    project_id: { type: 'string' } } },
  run: ({ project_id: pid }, ctx) =>
    jobVisibleTo(ctx.db, ctx.cid, pid)
      ? getOpenmaiResult(ctx.db, ctx.cid, pid)
      : { error: 'NOT_FOUND', project_id: pid },
};
