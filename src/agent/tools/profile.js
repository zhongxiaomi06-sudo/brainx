/** 我的档案(只读;写档案请到工作台设置页)。 */
import { loadConsultants } from '../../recommend.js';

export default {
  name: 'brainx_profile',
  description: '当前顾问的方向画像(profile_keywords/profile_note)。只读;修改请指引用户到工作台设置页。',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) => {
    const c = loadConsultants(ctx.db).find((x) => x.consultant_id === ctx.cid);
    if (!c) return { error: 'NOT_FOUND', consultant_id: ctx.cid };
    return { consultant_id: ctx.cid, display_name: c.display_name,
             profile_keywords: c.profile_keywords || [], profile_note: c.profile_note || '' };
  },
};
