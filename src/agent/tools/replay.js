/** 决策回放(冻结推荐 + 当轮 run + 事件 + 结果;只能回放本人名下推荐)。 */
import { replay } from '../../replay.js';
import { loadConsultants } from '../../recommend.js';

export default {
  name: 'brainx_replay',
  description: '决策回放:按 decision_id 重放冻结推荐(只读不重算)。只能回放当前顾问自己名下的推荐。',
  parameters: { type: 'object', required: ['decision_id'], properties: {
    decision_id: { type: 'string' } } },
  run: ({ decision_id }, ctx) => {
    const { db, cid } = ctx;
    if (!cid || !loadConsultants(db).some((c) => c.consultant_id === cid)) {
      return { error: 'UNKNOWN_CONSULTANT', consultant_id: cid };
    }
    const owner = db.prepare('SELECT consultant_id FROM recommendations WHERE decision_id=?').get(decision_id);
    if (!owner) return { error: 'NOT_FOUND', decision_id };
    if (owner.consultant_id !== cid) return { error: 'NOT_FOUND', decision_id }; // 跨人=不存在,与 HTTP 同口径
    return replay(db, decision_id);
  },
};
