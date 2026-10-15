/** 顾问本人长期排除的群内回执；不含候选联系方式或内部搜索键。 */
import { createHash } from 'node:crypto';
import { alignSoloAction } from './card-layout.js';

const plain = (content) => ({ tag: 'plain_text', content });
const safeName = (value) => String(value || '这位候选人')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[已隐藏]')
  .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g, '[已隐藏]')
  .replace(/[\r\n<>]/g, ' ').slice(0, 32);

export function candidateDecisionCard({ name, status, jobId, searchKey, candidateRef }) {
  const rejected = status === 'REJECTED';
  const label = rejected ? '已加入你的长期排除名单' : '已恢复，后续搜索可能重新出现';
  const action = searchKey ? 'RESTORE' : 'RESTORE_CANDIDATE';
  const call = searchKey
    ? `调用 brainx_freeform_candidate_action，search_key=${searchKey}、candidate_ref=${candidateRef}、action=${action}、confirm=true。`
    : `调用 brainx_candidate_workflow，job_id=${jobId}、candidate_ref=${candidateRef}、action=${action}、confirm=true。`;
  return {
    config: { wide_screen_mode: false },
    header: { template: rejected ? 'orange' : 'green', title: plain(label) },
    elements: [
      { tag: 'div', text: plain(`${safeName(name)} · 仅影响你的后续找人，不删除人才，也不影响其他顾问。`) },
      ...(rejected ? [alignSoloAction({ tag: 'action', actions: [{ tag: 'button', type: 'default',
        text: plain('撤销排除'), value: { text: `${call} 只按工具回执报告撤销结果。` } }] })] : []),
    ],
  };
}

export async function sendCandidateDecisionCard(sendCardFn, principal, data) {
  if (principal.chatType !== 'group' || !principal.chatId) return 'not_group';
  const card = candidateDecisionCard(data);
  const key = createHash('sha256').update(JSON.stringify([
    principal.tenantId, principal.consultantId, principal.chatId,
    data.candidateRef, data.status, data.updatedAt,
  ])).digest('hex').slice(0, 32);
  try { await sendCardFn({ target: principal.chatId, card, idempotencyKey: `decision-${key}` });
    return 'sent'; }
  catch { return 'failed'; }
}
