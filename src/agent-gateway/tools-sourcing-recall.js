/** tools-sourcing-recall.js — specs/036：在本人历史搜索结果里筛选/排序（零付费秒回）。
 *  语义分工：这里只回答「已有结果里有哪些」，要找全新的人用 brainx_supermai_scout。 */
import { recallSourcingCandidates } from '../sourcing-candidates.js';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };

const CAREER_LABEL = {
  recommended: '新推荐',
  screened: '已初筛',
  in_pool: '已入库',
  rejected: '已排除',
  restored: '已恢复',
};

export function createSourcingRecallToolHandlers({ db } = {}) {
  return { brainx_sourcing_recall: (args, context) => {
    const p = context.principal;
    const searchKey = String(args.search_key || '').trim() || null;
    if (searchKey && !/^[A-Za-z0-9:_-]{1,100}$/.test(searchKey)) fail('INVALID_ARGUMENT');
    const filter = String(args.filter || '').trim().slice(0, 200) || null;
    const city = String(args.city || '').trim().slice(0, 80) || null;
    const orderBy = ['score', 'time'].includes(args.order_by) ? args.order_by : 'score';
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const items = recallSourcingCandidates(db, {
      consultantId: p.consultantId, searchKey, filter, city, orderBy, limit,
    });
    const rows = items.map((row) => ({
      candidate_ref: row.candidate_ref,
      name: row.name,
      company: row.company,
      title: row.title,
      city: row.city,
      experience: row.experience,
      score: row.score_raw,
      career_status: row.career_status,
      career_label: CAREER_LABEL[row.career_status] || row.career_status,
      search_key: row.search_key,
      round: row.search_round,
      talent_url: row.talent_url,
    }));
    return {
      data: { recalled: rows.length, order_by: orderBy, items: rows },
      facts: [{ recall_only: true, paid_search_triggered: false }],
      inferences: [],
      recommendations: [{ action: 'present_or_narrow',
        note: rows.length
          ? '把 items 完整呈现给顾问（姓名/公司/职位/城市/匹配度/状态），不要自行省略或改写匹配度；'
            + '顾问要缩小范围时用 filter/city 参数再次调用本工具，要全新人选时才改用 brainx_supermai_scout。'
          : '没有命中的历史人选——如实告知；顾问要新人才用 brainx_supermai_scout 重新搜索。' }],
      unknowns: [],
      evidence_refs: [`sourcing_recall:${p.consultantId}:${searchKey || 'all'}`],
      next_allowed_actions: ['brainx_sourcing_recall', 'brainx_supermai_scout'],
    };
  } };
}
