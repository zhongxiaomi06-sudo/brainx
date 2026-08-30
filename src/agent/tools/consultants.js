/** 花名册(唯一可跨人的工具——仅姓名/ID 名单,与 open 路由 /api/v1/consultants 同口径)。 */
import { loadConsultants } from '../../recommend.js';

export default {
  name: 'brainx_consultants',
  description: '顾问花名册(consultant_id/显示名)。仅用于把人名和 consultant_id 对上,不含任何业务数据。',
  parameters: { type: 'object', properties: {} },
  run: (args, ctx) =>
    loadConsultants(ctx.db).map((c) => ({ consultant_id: c.consultant_id, display_name: c.display_name })),
};
