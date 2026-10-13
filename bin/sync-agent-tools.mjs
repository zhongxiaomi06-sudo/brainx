#!/usr/bin/env node
/** sync-agent-tools.mjs — specs/036 部署一键化：从 tool-registry 生成插件声明并同步 tools.allow。
 *  生产运行（ECS，brainx 用户）：
 *    node bin/sync-agent-tools.mjs --apply     # 副本同步 + config set（不动 git）
 *    node bin/sync-agent-tools.mjs             # dry-run：只打印差异
 *  复刻既有「3 处同步」②③：插件副本 4 文件 + openclaw.json tools.allow；
 *  ① tool-registry.js 是唯一事实源，声明内容不再手写两遍。 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const REPO = '/opt/brainx';
const EXT = '/var/lib/brainx/.openclaw/extensions/brainx-openclaw';
const FILES = ['openclaw.plugin.json', 'runtime.js', 'index.js', 'package.json'];
const ALLOW_KEY = 'tools.allow';

const registry = await import(`${REPO}/src/agent-gateway/tool-registry.js`);
const expected = registry.AGENT_TOOL_ROWS.map((r) => r.name);
const plugin = JSON.parse(readFileSync(`${REPO}/plugins/brainx-openclaw/openclaw.plugin.json`, 'utf8'));
const pluginTools = plugin.contracts.tools;
const inRegistryNotPlugin = expected.filter((n) => !pluginTools.includes(n));
const inPluginNotRegistry = pluginTools.filter((n) => !expected.includes(n));

console.log(`registry ${expected.length} / plugin ${pluginTools.length}`);
if (inRegistryNotPlugin.length) console.log('插件清单缺:', inRegistryNotPlugin.join(', '));
if (inPluginNotRegistry.length) console.log('插件清单多余:', inPluginNotRegistry.join(', '));

// ① 插件副本同步（cp + chown brainx）
for (const f of FILES) {
  console.log(`${APPLY ? '同步' : '[dry] 同步'} ${REPO}/plugins/brainx-openclaw/${f} -> ${EXT}/`);
  if (APPLY) {
    copyFileSync(`${REPO}/plugins/brainx-openclaw/${f}`, `${EXT}/${f}`);
    execFileSync('chown', ['brainx:brainx', `${EXT}/${f}`]);
  }
}

// ② tools.allow：openclaw config set（必须 brainx 用户执行，禁 root）
const cfg = JSON.parse(readFileSync('/var/lib/brainx/.openclaw/openclaw.json', 'utf8'));
const allow = cfg.tools?.allow || [];
const missing = expected.filter((n) => !allow.includes(n));
const dead = allow.filter((n) => !expected.includes(n) && !String(n).startsWith('openclaw'));
console.log(`tools.allow ${allow.length} 项，缺 ${missing.length}，死条目 ${dead.length}`);
if (missing.length) console.log('  缺失:', missing.join(', '));
if (dead.length) console.log('  死条目:', dead.join(', '));
if (APPLY && (missing.length || dead.length)) {
  const target = [...new Set([...expected, ...allow.filter((n) => !dead.includes(n) && String(n).startsWith('openclaw'))])];
  const value = JSON.stringify(target);
  console.log(`config set ${ALLOW_KEY}=${value}`);
  execFileSync('openclaw', ['config', 'set', ALLOW_KEY, value], { stdio: 'inherit' });
}

console.log(APPLY
  ? '完成。注意：config set 不热生效——需重启 openclaw-brainx；重启后在群里发一句「工具清单已更新，请重新调用」破除 agent session 旧认知。'
  : '[dry-run] 加 --apply 执行真实同步。');
