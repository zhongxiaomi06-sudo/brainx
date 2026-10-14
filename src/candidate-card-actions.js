/** 共享候选动作；取消二次确认时飞书不发送按钮回调。 */
export function freeformCandidateActions(job, candidate) {
  const searchKey = job.search_key || job.project_id;
  if (!/^supermai:[a-f0-9]{12}$/.test(searchKey || '')) return [];
  return [['SCREEN', '初筛通过'], ['ADD_TO_RELOOP', '加入reloop'], ['REJECT', '不合适'], ['CONTACT', '查联系方式']]
    .map(([action, label]) => ({ tag: 'button', type: action === 'SCREEN' ? 'primary' : 'default',
      text: { tag: 'plain_text', content: label },
      ...(action === 'REJECT' ? { confirm: { title: { tag: 'plain_text', content: '确认不合适？' },
        text: { tag: 'plain_text', content: '将此人加入你长期排除名单，后续所有找人不再推荐；可撤销，不影响其他顾问。' } } } : {}),
      value: { text: `调用 brainx_freeform_candidate_action，search_key=${searchKey}、candidate_ref=${candidate.candidateRef}、action=${action}、confirm=true。只按工具回执报告结果；联系方式只能私发我本人。` } }));
}

export function rejectCandidateAction(job, candidate) {
  return { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '不合适' },
    confirm: { title: { tag: 'plain_text', content: '确认不合适？' },
      text: { tag: 'plain_text', content: '将此人加入你长期排除名单，后续所有找人不再推荐；可撤销，不影响其他顾问。' } },
    value: { text: `[BRAINTEX_CANDIDATE_REJECT] 我已二次确认：调用 brainx_candidate_workflow，job_id=${job.project_id}、candidate_ref=${candidate.candidateRef}、action=REJECT_CANDIDATE、confirm=true。只为我长期排除，不删除人才、不影响其他顾问、不发起搜索。成功后明确回执。` } };
}

export function contactCandidateAction(job, candidate) {
  return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '查联系方式' },
    value: { text: `[BRAINTEX_CANDIDATE_CONTACT] 调用 brainx_candidate_workflow，job_id=${job.project_id}、candidate_ref=${candidate.candidateRef}、action=SEND_CONTACT_PRIVATE、confirm=true。只向我本人私发已授权联系方式，群内只回复送达或未授权状态。` } };
}
