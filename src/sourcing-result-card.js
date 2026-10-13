/** 寻访结果卡：只消费当前轮的冻结结果，不执行搜索或业务写入。 */
import { buildBrainxDeepLink, productionBaseUrl } from './brainx-deep-links.js';
import { alignSoloAction } from './card-layout.js';
import { assessOpenmaiCandidateBatch, extractOpenmaiCandidates } from './openmai-result.js';
import { normalizeExcludedCandidateRefs } from './search-rounds.js';
import { rejectCandidateAction, contactCandidateAction, freeformCandidateActions } from './candidate-card-actions.js';
const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function groupSafeOpenmaiText(value, max = 6500) {
  const cleaned = String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(PHONE, '[联系方式已隐藏]')
    .replace(EMAIL, '[联系方式已隐藏]')
    .trim();
  if (!cleaned) return 'OpenMai 已完成，但本轮没有返回可展示的候选人内容。';
  return cleaned.length > max ? `${cleaned.slice(0, max)}\n\n*内容较长，完整结果请在工作台查看。*` : cleaned;
}

export function buildOpenmaiDeliveryCard({ job, status, resultText, error, publicBaseUrl,
  source = 'openmai' }) {
  // freeform = SuperMai 自由找人模式（无职位）：判据摘要替代 company/role，不放 deep link。
  // 项目模式 job.freeform 不传，行为不变（AGENTS.md §2 最小实现：复用同一函数）。
  const freeform = job?.freeform === true;
  const baseUrl = freeform ? null : productionBaseUrl(publicBaseUrl).href;
  const target = freeform ? null
    : buildBrainxDeepLink({ baseUrl, objectType: 'opportunity', objectRef: job.project_id });
  const success = status === 'done' || status === 'needs_input';
  const quality = success ? assessOpenmaiCandidateBatch(resultText) : null;
  const needsInput = status === 'needs_input' || quality?.needsInput;
  const candidates = success ? extractOpenmaiCandidates(resultText) : [];
  const searchRound = Math.max(1, Number(job.search_round || 1));
  // 2026-09-16 用户拍板：首轮才写「首轮」，其他轮次用「续搜」，不写「第 N 轮」。
  const roundWord = searchRound > 1 ? '续搜' : '首轮';
  let excludedCount = '未记录';
  try {
    const refs = JSON.parse(job.excluded_candidate_refs_json || 'null');
    if (Array.isArray(refs)) excludedCount = normalizeExcludedCandidateRefs(refs).length;
  } catch { /* 历史损坏字段不猜人数。 */ }
  const brief = String(job.search_brief || job.criteria || '').trim();
  const brand = freeform ? 'SuperMai 自由找人'
    : source === 'supermai' ? 'SuperMai 候选人推荐' : 'OpenMai 候选人推荐';
  const readyTitle = `${brand} · ${roundWord}已就绪`;
  const partialTitle = `${brand} · ${roundWord}候选人不足`;
  const noMatches = status === 'done' && !candidates.length
    && ['', 'NO_REPLY'].includes(String(resultText || '').trim());
  const complete = success && quality.complete && !noMatches;
  const headline = freeform
    ? `**自由找人 · ${groupSafeOpenmaiText(job.criteria, 60) || '未给判据'}**`
    : `**${job.company} · ${job.role}**`;
  const content = success
    ? (candidates.length
      ? `${headline}\n\n本轮共找到 ${candidates.length} 位候选人。`
        + (quality.message ? `\n\n> ${quality.message}` : '')
      : `${headline}\n\n${noMatches ? '本轮未搜到匹配候选人。请确认可放宽的条件后重新发起；本次不会自动重跑。' : groupSafeOpenmaiText(resultText)}`)
    : `${headline}\n\n本轮候选人搜索失败：${groupSafeOpenmaiText(error, 500)}\n\n请修复连接后在工作台重试。`;
  const rows = candidates.length ? candidateFocusRows(job, candidates, source) : [];
  return {
    config: { wide_screen_mode: true },
    header: { template: complete ? 'green' : success ? 'orange' : 'red', title: { tag: 'plain_text',
      content: complete ? readyTitle
        : needsInput ? `${brand} · 请补充职位信息`
          : noMatches ? `${brand} · 未搜到` : success ? partialTitle : `${brand} · 搜索失败` } },
    elements: [
      { tag: 'markdown', content },
      { tag: 'note', elements: [{ tag: 'plain_text', content:
        `${roundWord} · ${excludedCount === '未记录' ? '排除人数未记录' : `已排除 ${excludedCount} 人`}\n本轮条件：${brief ? groupSafeOpenmaiText(brief, 240) : '按职位事实；本轮未记录补充条件'}` }] },
      // 说明收成一行小灰字 note：按钮与候选人随行后不再需要长段教学。
      ...(candidates.length ? [focusIntroNote(freeform, source)] : []),
      ...rows,
      // freeform 操作列统一「暂不支持」，不再逐条提示编号/链接问题（2026-10-09）。
      ...(freeform ? [] : candidateQualityNotes(candidates)),
      ...(candidates.length ? [continueSearchActions(job), ...(!freeform ? [continueSearchHint()] : [])] : []),
      // 失败 / 空结果卡只有这一个动作 → 右对齐收口（F4）。
      // freeform 无真实职位 → target 为 null → 不渲染「打开工作台」按钮，避免伪造链接（2026-09-16）。
      ...(!success || !candidates.length ? (target ? [alignSoloAction({ tag: 'action', actions: [{ tag: 'button', type: 'primary',
        text: { tag: 'plain_text', content: success ? '打开工作台查看与评估' : '打开工作台处理' },
        multi_url: { url: target, pc_url: target, android_url: target, ios_url: target } }] })] : []) : []),
    ],
  };
}

/** 候选人每人一行：姓名直接打开 TTC，右侧只保留初筛通过与加入 reloop。
 *  三列权重 3/5/3，动作按钮纵向排列，确保四字姓名和两个动作都不被截断。 */
function candidateFocusRows(job, candidates, source) {
  const freeform = job?.freeform === true;
  return [
    { tag: 'column_set', flex_mode: 'none', background_style: 'grey',
      columns: [tableCell('候选人', 3), tableCell('匹配与背景 · 核心匹配', 5), tableCell('操作', 3)] },
    ...candidates.map((candidate, index) => {
      const info = [
        `**匹配度 ${groupSafeOpenmaiText(candidate.score, 20)}** · ${groupSafeOpenmaiText(candidate.role, 120)}`,
        backgroundText(candidate),
        groupSafeOpenmaiText(candidate.evaluation, 300),
      ].filter(Boolean).join('\n');
      const url = ttcTalentUrl(candidate) || (source === 'supermai' ? candidate.profileUrl : null);
      const name = groupSafeOpenmaiText(candidate.name, 12);
      return { tag: 'column_set', flex_mode: 'none',
        background_style: index % 2 === 0 ? 'default' : 'grey', columns: [
          // freeform：无 TTC 链接也做姓名按钮，对齐项目卡格式（链接放空不跳转，2026-09-16 specs/018 修订）
          { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: [url
              ? candidateLinkButton(url, index + 1, name)
              : { tag: 'div', text: { tag: 'plain_text', content: `${index + 1}. ${name}` } }] },
          { tag: 'column', width: 'weighted', weight: 5, vertical_align: 'top',
            elements: [{ tag: 'markdown', content: info }] },
          // freeform：合成 project_id（supermai:<hash>）在 job_facts 无行，初筛/入 reloop
          // 按钮必然 NOT_FOUND_OR_FORBIDDEN——发卡接线修复后卡真实上会，不再渲染必败按钮
          // （2026-10-09；待 freeform 候选动作有真实承接后再恢复）。
          { tag: 'column', width: 'weighted', weight: 3, vertical_align: 'center',
            elements: candidate.candidateRefValid === false
              ? [{ tag: 'div', text: { tag: 'plain_text', content: '不可操作' } }]
              : freeform
                ? freeformCandidateActions(job, candidate)
                : [screenCandidateAction(job, candidate), addToReloopAction(job, candidate),
                  rejectCandidateAction(job, candidate), contactCandidateAction(job, candidate)] },
        ] };
    }),
  ];
}

function candidateLinkButton(url, no, name) {
  const btn = { tag: 'button', type: 'default', text: { tag: 'plain_text', content: `${no}. ${name}` } };
  // 仅对真实链接渲染按钮，缺来源时用纯文本。
  if (url) btn.multi_url = { url, pc_url: url, android_url: url, ios_url: url };
  return btn;
}

/** 一句话说明入口；freeform（自由找人）候选人无项目上下文，如实说明暂不支持一键操作。 */
function focusIntroNote(freeform = false, source = 'openmai') {
  return { tag: 'note', elements: [{ tag: 'plain_text',
    content: freeform
      ? '自由找人：原搜索发起人可操作；初筛记录在本次搜索重点名单，尚未关联职位；联系方式只私发。'
      : source === 'supermai'
        ? '有来源链接时可点姓名查看官方资料；初筛通过与加入 reloop 是独立操作。'
        : '点姓名直接查看 TTC；初筛通过后发送人才链接；加入 reloop 为独立操作。' }] };
}

/** 表格原来的「操作」列兼作「链接待核实」提示，该列移除后信号改在这里披露，避免静默丢失。 */
function candidateQualityNotes(candidates) {
  const numbered = candidates.map((candidate, index) => ({ candidate, no: index + 1 }));
  const invalid = numbered.filter(({ candidate }) => candidate.candidateRefValid === false);
  const unverified = numbered.filter(({ candidate }) => candidate.candidateRefValid !== false
    && !ttcTalentUrl(candidate));
  const notes = [];
  if (invalid.length) notes.push(`${invalid.map(({ no }) => no).join('、')} 号候选人编号无效，未生成关注按钮`);
  if (unverified.length) notes.push(`${unverified.map(({ no }) => no).join('、')} 号 TTC 链接待核实`);
  return notes.length
    ? [{ tag: 'note', elements: [{ tag: 'plain_text', content: notes.join('；') }] }] : [];
}

function continueSearchActions(job) {
  // freeform：无 job_id，不放 OpenMai 继续找人（需 job_id）；放 SuperMai 重新找人按钮。
  // 2026-10-09 修订：自由找人已支持 continue_search=true（排除名单按合成键从历史结果生成），
  // 按钮指令改为显式新一轮；自由找人群里没有自动投递通道，话术不得承诺「自动发到本群」。
  if (job?.freeform === true) {
    const criteria = String(job.criteria || '').slice(0, 2000);
    const command = `[BRAINTEX_FREEFORM_START] ${JSON.stringify({ criteria, continue_search: true })}`;
    // 单按钮行用 alignSoloAction 右对齐收口（卡片排版规范，2026-09-16 specs/018 修订）
    return alignSoloAction({ tag: 'action', actions: [
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'SuperMai 重新找人' },
        value: { text: command } },
    ] });
  }
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const command = (entry, tool) => `[BRAINTEX_SEARCH_START] 为项目 ${projectRef} 使用 ${entry} 继续找人。读取本群最近一条由顾问明确发送的“找人条件：”作为可选补充条件；现在第一次调用 ${tool}，传入 job_id=${projectRef} 和 continue_search=true。任务返回 running/triggered 后立即回复“正在继续找人，完成后候选人会自动发到本群”并结束本轮，不要原地轮询。后续若顾问主动询问进度，查询时必须把 continue_search 改为 false 或省略，同一次按钮任务绝不能再次传 true。排除名单必须由 BrainX 根据历史 TTC 编号生成，不要自行编造，也不要再次询问找人方式。`;
  return { tag: 'action', actions: [
    { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: 'OpenMai 继续找人' },
      value: { text: command('OpenMai', 'brainx_openmai_search') } },
    { tag: 'button', type: 'default', text: { tag: 'plain_text', content: 'SuperMai 继续找人' },
      value: { text: command('SuperMai', 'brainx_supermai_scout') } },
  ] };
}

function continueSearchHint() {
  return { tag: 'note', elements: [{ tag: 'plain_text',
    content: '继续找人时，先在群里发送“找人条件：……”，再点击上方继续找人；不发条件则按职位事实继续，并自动排除已推荐人选。' }] };
}

function tableCell(content, weight, elements) {
  return {
    tag: 'column', width: 'weighted', weight, vertical_align: 'top',
    elements: elements || [{ tag: 'div', text: { tag: 'plain_text', content } }],
  };
}

function ttcTalentUrl(candidate) {
  if (candidate.talentUrl) {
    try {
      const target = new URL(candidate.talentUrl);
      if (target.origin === 'https://app.ttcadvisory.com' && target.pathname.startsWith('/app/talent/')) {
        return target.toString();
      }
    } catch { /* 使用候选编号回退。 */ }
  }
  if (candidate.candidateRefValid === false) return null;
  // 仅 PL 编号是有效 TTC 人才编号（2026-09-16 JWT 实证：PT 外部渠道编号 TTC 查无此人），
  // 其余一律不拼链接，姓名列降级为纯文本。
  if (!/^PL\d{10,}$/.test(String(candidate.candidateRef || ''))) return null;
  return `https://app.ttcadvisory.com/app/talent/${encodeURIComponent(candidate.candidateRef)}`;
}

export function screenCandidateAction(job, candidate) {
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  const command = `[BRAINTEX_CANDIDATE_KEEP] 把项目 ${projectRef} 的候选人 ${candidate.candidateRef} 初筛通过。`
    + '这个按钮就是我的明确确认：现在调用 brainx_candidate_workflow，'
    + `传入 job_id=${projectRef}、candidate_ref=${candidate.candidateRef}、`
    + 'action=KEEP_FOR_REVIEW、confirm=true。成功后告诉群里“已初筛通过”，'
    + '并说明此人已进入本项目共享上下文，同时已发送 TTC 人才链接；不要发送简历。';
  return { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '初筛通过' },
    value: { text: command } };
}

export function addToReloopAction(job, candidate) {
  const projectRef = String(job.project_id || '').trim().slice(0, 64);
  return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: '加入reloop' },
    value: { text: `[BRAINTEX_TALENT_ADD] 职位 ${projectRef} 候选人 ${candidate.candidateRef}` } };
}

/** F8：中文数据在 372px 内摆不开，「7 年 · 深圳」会被折成「7 年 · 深\n圳」。
 *  把「经验 / 城市」与「学历」并成一行「背景」（`7 年 · 深圳 · 硕士 · 哈工大`），
 *  候选人信息列立刻宽裕。
 *  上游缺字段时会填「待核实」占位，直接拼会出现「待核实 · 待核实 · 待核实」，
 *  因此先剔除空值与占位、再去重，全空才回退成单个「待核实」。 */
function backgroundText(candidate) {
  const parts = [candidate.experience, candidate.city, candidate.education]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value && value !== '待核实');
  return [...new Set(parts.map((value) => groupSafeOpenmaiText(value, 40)))].join(' · ') || '待核实';
}
