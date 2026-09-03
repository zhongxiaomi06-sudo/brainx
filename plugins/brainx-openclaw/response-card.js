function safeWorkbenchUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function titleFor(text) {
  if (/候选人|人才|简历|面试/.test(text)) return 'BrainTex · 候选人建议';
  if (/职位|接单|招聘/.test(text)) return 'BrainTex · 职位决策';
  if (/复盘|进展|跟进/.test(text)) return 'BrainTex · 工作进展';
  if (/设置|每天|推送/.test(text)) return 'BrainTex · 推荐设置';
  return 'BrainTex · AI 猎头助手';
}

function contentBlocks(text) {
  const clean = text.trim().slice(0, 12_000);
  const sections = clean.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (sections.length <= 1) return [{ type: 'text', text: clean }];
  return sections.slice(0, 10).flatMap((section, index) => (
    index === 0 ? [{ type: 'text', text: section }] : [{ type: 'divider' }, { type: 'text', text: section }]
  ));
}

export function formatBrainxReplyPayload(event, { publicBaseUrl = process.env.BRAINX_BASE_URL } = {}) {
  const payload = event?.payload;
  if (event?.kind !== 'final' || event?.channel !== 'feishu' || payload?.presentation
      || payload?.isReasoning || payload?.isCommentary || payload?.isStatusNotice
      || typeof payload?.text !== 'string' || !payload.text.trim()) return undefined;
  const blocks = contentBlocks(payload.text);
  const workbenchUrl = safeWorkbenchUrl(publicBaseUrl);
  if (workbenchUrl) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'buttons', buttons: [{ label: '打开 BrainX 工作台', url: workbenchUrl, priority: 50 }] });
  }
  blocks.push({ type: 'context', text: '结论来自当前已授权数据；涉及写入、发送或状态变更时，机器人会先请求确认。' });
  return { payload: { ...payload, presentation: {
    title: titleFor(payload.text), tone: payload.isError ? 'danger' : 'info', blocks,
  } } };
}
