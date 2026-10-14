/** tools-sourcing-recall.js — specs/036：在本人历史搜索结果里筛选/排序（零付费秒回）。
 *  语义分工：这里只回答「已有结果里有哪些」，要找全新的人用 brainx_supermai_scout。 */
import { recallSourcingCandidates } from '../sourcing-candidates.js';

const fail = (code) => { throw Object.assign(new Error(code), { code }); };

/** specs/036 群测实证（10-13）：用户问「小红书或字节」时 LLM 会把「或」原样写进 filter，
 *  纯 AND 语义下必然零命中。这里把「或/或者/or//」统一折成「|」（数据层的 OR 分组语法）。 */
function normalizeFilterOr(raw) {
  return String(raw || '')
    .replace(/\s*(?:\|\||\||｜)\s*/g, '|')
    .replace(/\s*(?:或者?|\/)\s*/g, '|');
}

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
    const filter = normalizeFilterOr(args.filter).trim().slice(0, 200) || null;
    const city = String(args.city || '').trim().slice(0, 80) || null;
    const orderBy = ['score', 'time'].includes(args.order_by) ? args.order_by : 'score';
    const careerStatus = args.career_status === 'rejected' ? 'rejected' : null;
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
    const items = recallSourcingCandidates(db, {
      consultantId: p.consultantId, tenantId: p.tenantId, searchKey, filter, city,
      orderBy, limit, careerStatus,
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
      data: { recalled: rows.length, order_by: orderBy, career_status: careerStatus, items: rows },
      facts: [{ recall_only: true, paid_search_triggered: false }],
      inferences: [],
      recommendations: [{ action: 'present_or_narrow',
        note: rows.length
          ? '把 items 完整呈现给顾问（姓名/公司/职位/城市/匹配度/状态），不要自行省略或改写匹配度；'
            + '顾问要缩小范围时用 filter/city 参数再次调用本工具（filter 词间是「且」、用「|」表示「或」，如「小红书|字节」），要全新人选时才改用 brainx_supermai_scout。'
          : careerStatus === 'rejected' ? '目前没有可查的长期排除人选；不要触发付费找人。'
            : '没有命中时先建议放宽（去掉一个关键词，或把「或」写成「A|B」）再调一次；确认没有才如实告知，'
              + '顾问要新人才用 brainx_supermai_scout 重新搜索。' }],
      unknowns: [],
      evidence_refs: [`sourcing_recall:${p.consultantId}:${searchKey || 'all'}`],
      next_allowed_actions: ['brainx_sourcing_recall', 'brainx_supermai_scout'],
    };
  } };
}
