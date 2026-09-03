import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { createBraintexHomeCommand } from './onboarding.js';
import { BRAINX_OPENCLAW_TOOLS, createBrainxToolFactory } from './runtime.js';
import { formatBrainxReplyPayload } from './response-card.js';

export default definePluginEntry({
  id: 'brainx-openclaw',
  name: 'BrainX Recruiting Tools',
  description: 'Least-privilege recruiting decision tools for Feishu consultants.',
  register(api) {
    api.registerCommand(createBraintexHomeCommand());
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
