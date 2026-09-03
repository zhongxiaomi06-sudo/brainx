import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

import { createBraintexHomeCommand } from './onboarding.js';
import { BRAINX_OPENCLAW_TOOLS, createBrainxToolFactory } from './runtime.js';

export default definePluginEntry({
  id: 'brainx-openclaw',
  name: 'BrainX Recruiting Tools',
  description: 'Least-privilege recruiting decision tools for Feishu consultants.',
  register(api) {
    api.registerCommand(createBraintexHomeCommand());
    for (const row of BRAINX_OPENCLAW_TOOLS) {
      api.registerTool(createBrainxToolFactory(row), { name: row.name });
    }
  },
});
