import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { createBraintexHomeCommand, createCandidateReportCommand } from './onboarding.js';
import { BRAINX_OPENCLAW_TOOLS, createBrainxToolFactory } from './runtime.js';
import { formatBrainxReplyPayload } from './response-card.js';
import { createBraintexPromptContext, preloadSpecialGroupDoc } from './prompt.js';
import { createSearchStartNoticeHandler } from './search-start-notice.js';
import { createMentionSilenceHandler } from './mention-silence.js';
import { loadUserHooksConfig, createUserHookHandler } from './user-hooks.js';

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
    // Per-user hook（私聊接单、私聊拉群、群固定文案等）全部来自配置而非代码：
    // 开通新顾问 = 在 user-hooks.json（或 BRAINX_USER_HOOKS_FILE 指向的文件）加一条
    // { trigger, action } 配置。priority 由每条配置自带，均低于 mention-silence(100)、
    // 高于 LLM；mention-silence 不拦 @braintex 的消息，与群固定文案类 hook 不冲突。
    // 每条 hook 都注册 message_received 缓存入站文本（before_agent_reply 的 event 不含原文）。
    const userHooks = loadUserHooksConfig();
    for (const error of userHooks.errors) api.logger?.warn?.(`[brainx-user-hooks] ${error}`);
    for (const hook of userHooks.hooks) {
      const handler = createUserHookHandler(hook);
      api.on('message_received', handler.onMessageReceived);
      api.on('before_agent_reply', handler, { priority: hook.priority ?? 95 });
    }
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
