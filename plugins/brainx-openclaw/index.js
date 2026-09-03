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
    api.registerHook('reply_payload_sending', formatBrainxReplyPayload, {
      name: 'brainx-rich-replies',
      description: '把 BrainTex 的飞书最终回答渲染为结构化卡片。',
    });
    for (const row of BRAINX_OPENCLAW_TOOLS) {
      api.registerTool(createBrainxToolFactory(row), { name: row.name });
    }
  },
});
