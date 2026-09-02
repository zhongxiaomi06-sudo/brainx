#!/usr/bin/env node
import '../src/env.js';
import { openDb } from '../src/db.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import { createAgentGatewayServer } from '../src/agent-gateway/server.js';

function appHashesFromEnv() {
  const source = JSON.parse(process.env.BRAINX_AGENT_FEISHU_APP_KEYS_JSON || '{}');
  return Object.fromEntries(Object.entries(source).map(([account, appKey]) => [account, hashFeishuAppKey(appKey)]));
}

const server = createAgentGatewayServer({
  db: openDb(),
  registry: createToolRegistry(),
  gatewayToken: process.env.BRAINX_AGENT_GATEWAY_TOKEN,
  assertionSecret: process.env.BRAINX_AGENT_ASSERTION_SECRET,
  auditKey: process.env.BRAINX_AGENT_AUDIT_KEY,
  feishuAppKeyHashes: appHashesFromEnv(),
});

server.listen(3102, '127.0.0.1', () => {
  console.error('BrainX Agent Gateway listening on http://127.0.0.1:3102');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
