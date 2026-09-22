import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { createBraintexHomeCommand, createCandidateReportCommand } from './onboarding.js';
import { BRAINX_OPENCLAW_TOOLS, createBrainxToolFactory } from './runtime.js';
import { formatBrainxReplyPayload } from './response-card.js';
import { createBraintexPromptContext, preloadSpecialGroupDoc } from './prompt.js';
import { createSearchStartNoticeHandler } from './search-start-notice.js';
import { createMentionSilenceHandler } from './mention-silence.js';
import { createYangOfferReplyHandler } from './yang-offer-reply.js';

export default definePluginEntry({
  id: 'brainx-openclaw',
  name: 'BrainX Recruiting Tools',
  description: 'Least-privilege recruiting decision tools for Feishu consultants.',
  register(api) {
    api.registerCommand(createBraintexHomeCommand());
    api.registerCommand(createCandidateReportCommand());
    api.on('before_prompt_build', (_event, context) => {
      const prependSystemContext = createBraintexPromptContext(context);
      return prependSystemContext ? { prependSystemContext } : undefined;
    });
    api.on('message_received', createSearchStartNoticeHandler(api));
    const mentionSilence = createMentionSilenceHandler();
    api.on('message_received', (event, context) => mentionSilence.onMessageReceived(event, context));
    // 群级特殊背景文档预加载（fire-and-forget，不阻塞消息处理）：
    // 消息入站时异步拉飞书文档到 prompt.js 的 docCache，before_prompt_build 同步读缓存。
    api.on('message_received', (event, context) => {
      const chatId = [context?.conversationId, event?.metadata?.chatId, event?.metadata?.to]
        .map((value) => String(value || '').trim().replace(/^chat:/, ''))
        .find((value) => /^oc_[A-Za-z0-9_-]+$/.test(value));
      if (chatId) void preloadSpecialGroupDoc(chatId);
    });
    // before_agent_reply 拦普通文本回复（reply_payload_sending 只覆盖富负载，2026-09-14 探针实证）。
    api.on('before_agent_reply', mentionSilence.onBeforeAgentReply, { priority: 100 });
    // 杨东旭 Offer 群固定文案回复（priority 90，在 mention-silence 之后但在 LLM 之前；
    // mention-silence 不会拦 @braintex 的消息，所以两者不冲突）。
    api.on('before_agent_reply', createYangOfferReplyHandler(), { priority: 90 });
    api.on('reply_payload_sending', (event, context) => {
      const result = formatBrainxReplyPayload(event, context);
      api.logger?.info?.(`[brainx-rich-replies] kind=${event?.kind || 'unknown'} channel=${event?.channel || context?.channelId || 'unknown'} applied=${Boolean(result)}`);
      return result;
    }, { priority: 50 });
    for (const row of BRAINX_OPENCLAW_TOOLS) {
      api.registerTool(createBrainxToolFactory(row), { name: row.name });
    }
  },
});
