const FIELD_LABELS = ['结论', '关键依据', '主要风险', '下一步'];

function safeWorkbenchUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function jobDeepLink(baseUrl, projectId) {
  if (!baseUrl || !projectId) return null;
  const url = new URL(baseUrl);
  url.searchParams.set('open', `opportunity:${projectId}`);
  return url.toString();
}

function titleFor(text) {
  if (/候选人|人才|简历|面试/.test(text)) return 'BrainTex · 候选人建议';
  if (/职位|接单|招聘/.test(text)) return 'BrainTex · 今日职位推荐';
  if (/复盘|进展|跟进/.test(text)) return 'BrainTex · 工作进展';
  if (/设置|每天|推送/.test(text)) return 'BrainTex · 推荐设置';
  return 'BrainTex · AI 猎头助手';
}

function cleanMarkdown(value) {
  return String(value || '').replace(/^\s*\*{1,2}|\*{1,2}\s*$/g, '').replace(/`/g, '').trim();
}

function parseFields(body) {
  const fields = Object.fromEntries(FIELD_LABELS.map((label) => [label, '']));
  let active = null;
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^\*{0,2}(结论|关键依据|主要风险|下一步)[：:]\*{0,2}\s*(.*)$/);
    if (match) {
      active = match[1];
      fields[active] = cleanMarkdown(match[2]);
    } else if (active && line) {
      fields[active] = `${fields[active]} ${cleanMarkdown(line)}`.trim();
    }
  }
  return fields;
}

function parseJobHeader(raw) {
  const header = cleanMarkdown(raw);
  const parts = header.split(/[｜|]/).map(cleanMarkdown).filter(Boolean);
  const possibleId = parts.at(-1);
  const projectId = /^[A-Za-z0-9_-]{4,64}$/.test(possibleId || '') ? possibleId : null;
  if (projectId) parts.pop();
  return {
    company: parts[0] || '公司待确认',
    role: parts.slice(1).join('｜') || '职位待确认',
    projectId,
  };
}

function parseRecommendation(text) {
  const normalizedText = text.replace(
    /^(\s*\d{1,2}[.)、]\s*)\*{0,2}公司[：:]\*{0,2}\s*(.+?)\s*\n\*{0,2}职位[：:]\*{0,2}\s*(.+?)\s*\n\*{0,2}职位\s*ID[：:]\*{0,2}\s*`?([A-Za-z0-9_-]{4,64})`?\s*$/gim,
    '$1$2｜$3｜$4',
  );
  const pattern = /^(?:#{1,4}\s*)?(\d{1,2})[.)、]\s*(.+?)\s*$/gm;
  const matches = [...normalizedText.matchAll(pattern)];
  if (!matches.length || !/职位|岗位|推荐/.test(normalizedText)) return null;
  const jobs = matches.slice(0, 10).map((match, index) => {
    const end = matches[index + 1]?.index ?? normalizedText.length;
    return {
      rank: Number(match[1]),
      ...parseJobHeader(match[2]),
      fields: parseFields(normalizedText.slice(match.index + match[0].length, end)),
    };
  }).filter((job) => job.projectId || job.fields.结论 || job.fields.关键依据);
  if (!jobs.length) return null;
  const intro = normalizedText.slice(0, matches[0].index).replace(/^\s*#+\s*[^\n]+\n?/, '').trim();
  return { intro, jobs };
}

function handlingCommand(job) {
  return `请处理职位 ${job.projectId || `${job.company} ${job.role}`}：先读取职位负责人和当前状态，展示联系人；再询问我是只核验、接单并启动找人，还是暂不处理。任何写入都要等我本次明确确认。`;
}

function recommendationBlocks(recommendation, workbenchUrl) {
  const blocks = [];
  if (recommendation.intro) blocks.push({ type: 'text', text: recommendation.intro.slice(0, 600) });
  blocks.push({
    type: 'context',
    text: `本轮共 ${recommendation.jobs.length} 个职位 · 每项展示结论、依据、风险和下一步`,
  });
  recommendation.jobs.forEach((job, index) => {
    if (index > 0 || recommendation.intro) blocks.push({ type: 'divider' });
    const { 结论, 关键依据, 主要风险, 下一步 } = job.fields;
    const facts = [
      `**${job.rank}. ${job.company}｜${job.role}**${job.projectId ? `\n\`${job.projectId}\`` : ''}`,
      `**结论**：${结论 || '待进一步核验'}`,
      `**依据**：${关键依据 || '当前证据不足'}`,
      `**风险**：${主要风险 || '暂无明确风险记录'}`,
      `**下一步**：${下一步 || '查看职位事实后决定是否推进'}`,
    ];
    blocks.push({ type: 'text', text: facts.join('\n') });
    const detailUrl = jobDeepLink(workbenchUrl, job.projectId);
    const buttons = [];
    if (detailUrl) buttons.push({ label: '查看职位', url: detailUrl, priority: 50, style: 'primary' });
    buttons.push({
      label: detailUrl ? '联系人与推进' : '查看联系人',
      action: { type: 'command', command: handlingCommand(job) },
      priority: 40,
    });
    if (!detailUrl) {
      buttons.push({
        label: '推进此职位',
        action: { type: 'command', command: handlingCommand(job) },
        priority: 30,
      });
    }
    blocks.push({ type: 'buttons', buttons });
  });
  if (recommendation.jobs.length < 10) {
    blocks.push({ type: 'divider' });
    blocks.push({
      type: 'buttons',
      buttons: [{
        label: '调整每日推荐',
        action: { type: 'command', command: '请读取我的每日推荐设置，并让我用自然语言调整每天的推荐时间和职位数量。' },
        priority: 20,
      }],
    });
  }
  return blocks;
}

function genericBlocks(text, workbenchUrl) {
  const clean = text.trim().slice(0, 12_000);
  const sections = clean.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const blocks = sections.length <= 1 ? [{ type: 'text', text: clean }] : sections.slice(0, 10)
    .flatMap((section, index) => (index === 0
      ? [{ type: 'text', text: section }]
      : [{ type: 'divider' }, { type: 'text', text: section }]));
  if (workbenchUrl) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'buttons', buttons: [{ label: '打开 BrainX 工作台', url: workbenchUrl.toString(), priority: 50 }] });
  }
  return blocks;
}

export function formatBrainxReplyPayload(event, context = {}) {
  const publicBaseUrl = context.publicBaseUrl ?? process.env.BRAINX_BASE_URL;
  const payload = event?.payload;
  const channel = event?.channel ?? context.channelId;
  const hasExistingControls = payload?.presentation?.blocks?.some(({ type }) => type === 'buttons' || type === 'select');
  if (event?.kind !== 'final' || channel !== 'feishu' || hasExistingControls
      || payload?.isReasoning || payload?.isCommentary || payload?.isStatusNotice
      || typeof payload?.text !== 'string' || !payload.text.trim()) return undefined;
  const workbenchUrl = safeWorkbenchUrl(publicBaseUrl);
  const recommendation = parseRecommendation(payload.text);
  const blocks = recommendation
    ? recommendationBlocks(recommendation, workbenchUrl)
    : genericBlocks(payload.text, workbenchUrl);
  blocks.push({
    type: 'context',
    text: '依据当前已授权数据生成；查看联系人是只读动作，接单、启动找人或改变状态前会再次请你确认。',
  });
  return {
    payload: {
      ...payload,
      presentation: {
        title: recommendation ? 'BrainTex · 今日职位推荐' : titleFor(payload.text),
        tone: payload.isError ? 'danger' : 'info',
        blocks,
      },
    },
  };
}
