/** 只呈现提取草稿；点击确认才建岗，缺字段不编造。 */
const safe = value => String(value ?? '待补充')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱隐藏]')
  .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[电话隐藏]').slice(0, 100);
export function buildJdConfirmationCard(data) {
  const f = data.fields || {};
  return { config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '请确认职位信息' } },
    elements: [
      { tag: 'div', text: { tag: 'plain_text', content: `公司：${safe(f.company)}\n职位：${safe(f.role)}\n城市：${safe(f.city)}\nHC：${safe(f.hc)}` } },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '来自你提交的 JD 草稿；尚未建岗、接单或启动找人。' }] },
      ...(f.company && f.role ? [{ tag: 'action', actions: ['confirm', 'reject'].map(action => ({
        tag: 'button', type: action === 'confirm' ? 'primary' : 'default',
        text: { tag: 'plain_text', content: action === 'confirm' ? '确认建岗' : '不采用' },
        value: { text: `调用 brainx_review_job_fact，draft_id=${data.draft_ref}、action=${action}、confirm=true。只确认这份草稿，不自动找人。` },
      })) }] : [{ tag: 'note', elements: [{ tag: 'plain_text', content: '公司或职位名称缺失，请补充完整 JD 后重新提交。' }] }]),
    ] };
}
