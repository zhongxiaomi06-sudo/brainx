/** 下一行动建议(只读草案,不写库——用户要"推进建议"时的主力工具)。 */
import { suggestedAction } from '../../commitment.js';
import { jobVisibleTo } from '../../visibility.js';

export default {
  name: 'brainx_progress_suggestion',
  description: '按当前阶段/阻塞状态生成可审计的下一行动草案(只读,不写库)。kind: PROGRESS(默认)/STAGE/BLOCKED。',
  parameters: { type: 'object', required: ['project_id'], properties: {
    project_id: { type: 'string' },
    kind: { type: 'string', enum: ['PROGRESS', 'STAGE', 'BLOCKED'] },
    stage: { type: 'string', description: 'STAGE/BLOCKED 时指定的阶段名' } } },
  run: ({ project_id: pid, ...input }, ctx) =>
    jobVisibleTo(ctx.db, ctx.cid, pid)
      ? suggestedAction(ctx.db, ctx.cid, pid, input)
      : { error: 'NOT_FOUND', project_id: pid },
};
