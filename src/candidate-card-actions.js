/** 共享候选动作；取消二次确认时飞书不发送按钮回调。 */
export function rejectCandidateAction(job, candidate) {
  return { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: '不合适' },
    confirm: { title: { tag: 'plain_text', content: '确认不合适？' },
      text: { tag: 'plain_text', content: '为你在这个职位的后续搜索排除此人，不影响其他顾问。可让助手撤销。' } },
    value: { text: `[BRAINTEX_CANDIDATE_REJECT] 我已二次确认：调用 brainx_candidate_workflow，job_id=${job.project_id}、candidate_ref=${candidate.candidateRef}、action=REJECT_CANDIDATE、confirm=true。只记录当前职位的负反馈并排除，不删除人才、不发起搜索。成功后明确回执。` } };
}

export function contactCandidateAction(job, candidate) {
  return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '查联系方式' },
    value: { text: `[BRAINTEX_CANDIDATE_CONTACT] 调用 brainx_candidate_workflow，job_id=${job.project_id}、candidate_ref=${candidate.candidateRef}、action=SEND_CONTACT_PRIVATE、confirm=true。只向我本人私发已授权联系方式，群内只回复送达或未授权状态。` } };
}
