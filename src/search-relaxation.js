/** 只对显式软偏好提出放宽；无法区分硬/软时不猜，不调用模型改写。 */
import { alignSoloAction } from './card-layout.js';
export function suggestSearchRelaxation(value) {
  const original = String(value || '').trim();
  if (!original || original.length > 1500 || /1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(original)) return null;
  const parts = original.split(/[；;。\n]+/).map(s => s.trim()).filter(Boolean);
  const soft = part => /^(?:优先|最好|加分项[：:]|倾向[：:])/.test(part)
    && !/必须|硬性|至少|不得|不能|不接受|仅限|只要|且|但是|不过|不低于|及以上/.test(part);
  const removed = parts.filter(soft);
  const kept = parts.filter(part => !soft(part));
  if (!removed.length || !kept.length || kept.join('；').length < 5) return null;
  const criteria = `${kept.join('；')}\n本轮明确取消以下非硬性偏好：${removed.join('；')}。其余条件保持不变。`;
  return { criteria, removed };
}
export function relaxedSearchElements(job, source = 'openmai') {
  const suggestion = suggestSearchRelaxation(job.search_brief || job.criteria);
  if (!suggestion) return [{ tag: 'note', elements: [{ tag: 'plain_text',
    content: '未识别到可安全放宽的明确偏好。请先补充哪些条件可以调整，不会自动删除硬性要求。' }] }];
  const freeform = job.freeform === true;
  // 条件变化意味着独立搜索作用域，不能冒充原条件的续搜。
  const payload = freeform ? { criteria: suggestion.criteria, continue_search: false }
    : { job_id: job.project_id, entry: source === 'supermai' ? 'SuperMai' : 'OpenMai',
      criteria: suggestion.criteria, continue_search: true };
  return [
    { tag: 'note', elements: [{ tag: 'plain_text', content: `建议仅取消：${suggestion.removed.join('；')}。其余条件不变。` }] },
    alignSoloAction({ tag: 'action', actions: [{ tag: 'button', type: 'primary',
      text: { tag: 'plain_text', content: '按建议放宽重搜' },
      confirm: { title: { tag: 'plain_text', content: '确认放宽并重新找人？' },
        text: { tag: 'plain_text', content: `只取消：${suggestion.removed.join('；')}。会发起一次新搜索，可能计费。${freeform ? '新条件为独立搜索，不继承原条件的候选排除记录。' : ''}` } },
      value: { text: `${freeform ? '[BRAINTEX_FREEFORM_START]' : '[BRAINTEX_PROJECT_START]'} ${JSON.stringify(payload)}` } }] }),
  ];
}
