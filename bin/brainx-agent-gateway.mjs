#!/usr/bin/env node
import '../src/env.js';
import { openDb } from '../src/db.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { createProductionToolRegistry } from '../src/agent-gateway/tool-registry.js';
import { createAgentGatewayServer } from '../src/agent-gateway/server.js';

function appHashesFromEnv() {
  const source = JSON.parse(process.env.BRAINX_AGENT_FEISHU_APP_KEYS_JSON || '{}');
  return Object.fromEntries(Object.entries(source).map(([account, appKey]) => [account, hashFeishuAppKey(appKey)]));
}

// 启动自检：BRAINX_BASE_URL 缺失时，深链与项目群卡片类工具会以
// BRAINX_BASE_URL_REQUIRED 失败，而报错点离配置很远、只在顾问点按钮时才暴露
// （2026-09-11 felix 在「linda -投放增长转项群」绑定失败事故）。
// 这里显式告警，让运维在启动日志里就能看见。
if (!process.env.BRAINX_BASE_URL) {
  console.error('[brainx] WARN: BRAINX_BASE_URL 未配置；深链与项目群卡片类工具将不可用'
    + '（检查 /etc/brainx/base-url.env 是否已挂到本服务的 EnvironmentFile）');
}

const db = openDb();
const server = createAgentGatewayServer({
  db,
  registry: createProductionToolRegistry({ db }),
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
