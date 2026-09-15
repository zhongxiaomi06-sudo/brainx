/** shortlist-card.js — 内部人才库短名单的群卡片（代码确定性渲染）。
 *
 * 背景：模型在群里拿到 brainx_candidate_shortlist 结果后自由排版候选人名单
 * （多轮对话后变成不规范 markdown、自制“匹配 93%”）。改为 handler 确定性把
 * 本页短名单渲染成标准卡片发到群里，模型只回一句引导语。
 *
 * 视觉与按钮行为对齐 src/openmai-delivery.js 的 candidateFocusRows（PR #62 定版）：
 * 同样的 3/5/3 三列行、同样的「初筛通过」「加入reloop」按钮——按钮 value 指令
 * 直接复用 openmai-delivery.js 导出的 screenCandidateAction / addToReloopAction，
 * 不复制指令文本，避免两处漂移。
 *
 * 与 openmai 候选人的差异：
 *   - 短名单姓名是脱敏名（如「张*」），candidate_ref 是内部受控引用而非 TTC 编号，
 *     不能拼 TTC 人才链接 → 姓名列用纯文本（candidateFocusRows 无链接时的同款回退）。
 *   - 行信息来自 candidate_match_bundle_v1：匹配度=job_fit.score、
 *     角色=最近一段经历 title、背景=城市/学历、评价=strength.summary。
 */
import { groupSafeOpenmaiText, screenCandidateAction, addToReloopAction } from './openmai-delivery.js';

function tableCell(content, weight, elements) {
  return {
    tag: 'column', width: 'weighted', weight, vertical_align: 'top',
    elements: elements || [{ tag: 'div', text: { tag: 'plain_text', content } }],
  };
}

/** 短名单说明：姓名不可点（内部引用无 TTC 链接），与 openmai 卡的说明区分开。 */
function shortlistIntroNote() {
  return { tag: 'note', elements: [{ tag: 'plain_text',
    content: '姓名为脱敏展示；初筛通过后发送人才链接；加入 reloop 为独立操作。' }] };
}

function roleOf(item) {
  return groupSafeOpenmaiText(item.profile?.recent_experiences?.[0]?.title
    || item.profile?.skills?.[0] || '候选人', 120);
}

function backgroundOf(item) {
  const education = item.profile?.education?.[0];
  const parts = [
    item.profile?.current_city,
    education ? [education.degree, education.school].filter(Boolean).join(' · ') : null,
  ].map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '待核实');
  return [...new Set(parts.map((value) => groupSafeOpenmaiText(value, 40)))].join(' · ') || '待核实';
}

function infoOf(item) {
  return [
    `**匹配度 ${groupSafeOpenmaiText(item.job_fit?.score, 20)}** · ${roleOf(item)}`,
    backgroundOf(item),
    groupSafeOpenmaiText(item.strength?.summary, 300),
  ].filter(Boolean).join('\n');
}

/** 候选人每人一行：纯文本脱敏名 + 匹配信息 + 初筛通过/加入reloop（与 openmai 卡同指令）。 */
function shortlistRows(job, items) {
  return [
    { tag: 'column_set', flex_mode: 'none', background_style: 'grey',
      columns: [tableCell('候选人', 3), tableCell('匹配与背景 · 核心匹配', 5), tableCell('操作', 3)] },
    ...items.map((item, index) => {
      const name = groupSafeOpenmaiText(item.display_name_masked, 12);
      const candidate = { candidateRef: item.candidate_ref };
      return { tag: 'column_set', flex_mode: 'none',
        background_style: index % 2 === 0 ? 'default' : 'grey', columns: [
          { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: [{ tag: 'div', text: { tag: 'plain_text',
              content: `${item.rank || index + 1}. ${name}` } }] },
          { tag: 'column', width: 'weighted', weight: 5, vertical_align: 'top',
            elements: [{ tag: 'markdown', content: infoOf(item) }] },
          { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: [screenCandidateAction(job, candidate), addToReloopAction(job, candidate)] },
        ] };
    }),
  ];
}

/**
 * 内部短名单群卡片。
 * @param {object} input.job    { project_id, company, role }（job_facts 行即可）。
 * @param {Array}  input.items  candidate_match_bundle_v1 的 items（本页）。
 * @param {number} [input.total]  短名单总人数提示（缺省用 items.length）。
 */
export function buildShortlistCard({ job, items, total }) {
  const label = [job.company, job.role].filter(Boolean).join(' · ') || '当前职位';
  const count = Number.isInteger(total) ? total : items.length;
  return {
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text',
      content: '内部人才库短名单 · 已就绪' } },
    elements: [
      { tag: 'markdown', content: `**${groupSafeOpenmaiText(label, 200)}**\n\n`
        + `本页 ${items.length} 位候选人（内部人才库授权短名单，共 ${count} 人，按匹配度排序）。` },
      shortlistIntroNote(),
      ...shortlistRows(job, items),
    ],
  };
}
