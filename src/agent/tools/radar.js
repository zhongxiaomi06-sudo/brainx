/** 机会雷达(当前顾问可见职位池 + 字段覆盖率 + 最新 TTC 字段报告)。 */
import { radarPayload } from '../../radar.js';

export default {
  name: 'brainx_radar',
  description: '机会雷达:当前顾问可见的候选职位池(公司/岗位/城市/管线阶段/HC/关系/状态)+ 字段覆盖能力。扫机会面时用。',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) => radarPayload(ctx.db, ctx.cid),
};
