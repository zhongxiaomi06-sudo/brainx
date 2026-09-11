const SEARCH_COMMAND = /^(?:\[BRAINTEX_SEARCH_START\]\s*)?为项目\s+([A-Za-z0-9_-]{1,64})\s+使用\s+(OpenMai|SuperMai)\s+(?:(继续)\s*)?找人。/;

export function parseSearchStartNotice(content) {
  const match = String(content || '').trim().match(SEARCH_COMMAND);
  if (!match) return null;
  const continuing = Boolean(match[3]);
  return {
    projectRef: match[1],
    entry: match[2],
    continuing,
    text: `🔎 正在处理 ${match[2]} ${continuing ? '继续' : ''}找人请求，通常需要 3–5 分钟；完成后候选人会自动发到本群。`,
  };
}

function groupTarget(event, context) {
  return [context?.conversationId, event?.metadata?.chatId, event?.from]
    .map((value) => String(value || '').trim())
    .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value)) || null;
}

export function createSearchStartNoticeHandler(api) {
  const delivered = new Set();
  return async (event, context = {}) => {
    if (context.channelId !== 'feishu') return false;
    const notice = parseSearchStartNotice(event?.content);
    const to = groupTarget(event, context);
    if (!notice || !to) return false;
    const key = String(event?.messageId || event?.runId || `${to}:${notice.projectRef}:${notice.entry}:${notice.continuing}`);
    if (delivered.has(key)) return false;
    try {
      const sendText = (await api.runtime.channel.outbound.loadAdapter('feishu'))?.sendText;
      if (!sendText) return false;
      await sendText({
        cfg: api.runtime.config?.current?.() ?? api.config,
        to,
        text: notice.text,
        ...(context.accountId ? { accountId: context.accountId } : {}),
      });
      delivered.add(key);
      if (delivered.size > 256) delivered.delete(delivered.values().next().value);
      return true;
    } catch (error) {
      api.logger?.warn?.(`[brainx-search-notice] delivery failed: ${String(error?.message || error).slice(0, 160)}`);
      return false;
    }
  };
}
