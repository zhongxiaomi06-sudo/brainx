import { formatBrainxReplyPayload } from './response-card.js';

/**
 * Current OpenClaw Feishu inbound replies do not consistently execute the
 * reply_payload_sending rewrite.  message_sending is the last typed hook before
 * transport, so deliver the same payload through the channel adapter and cancel
 * only after the replacement has succeeded.  Failure keeps the original text.
 */
export function createRichReplySendingHandler(api) {
  return async (event, context = {}) => {
    if (context.channelId !== 'feishu' || typeof event?.content !== 'string') return undefined;
    const formatted = formatBrainxReplyPayload({
      kind: 'final', channel: 'feishu', payload: { text: event.content },
    });
    if (!formatted) return undefined;
    try {
      const outbound = await api.runtime.channel.outbound.loadAdapter('feishu');
      if (!outbound?.sendPayload) return undefined;
      await outbound.sendPayload({
        cfg: api.runtime.config?.current?.() ?? api.config,
        to: event.to,
        payload: formatted.payload,
        text: formatted.payload.text,
        ...(context.accountId ? { accountId: context.accountId } : {}),
        ...(event.replyToId != null ? { replyToId: String(event.replyToId) } : {}),
        ...(event.threadId != null ? { threadId: event.threadId } : {}),
      });
      return { cancel: true, cancelReason: 'brainx_rich_reply_sent' };
    } catch (error) {
      api.logger?.warn?.(`[brainx-rich-replies] delivery failed: ${String(error?.message || error).slice(0, 160)}`);
      return undefined;
    }
  };
}
