/** tool-contract-drift.test.mjs — specs/019 US5：接口面漂移门禁。
 *
 * 权威契约: specs/019-hub-event-backbone/contracts/event-types.md（US5 地基）。
 * 五个接口面必须同源一致，任一漂移即失败并指名漂移工具：
 *   ① src/agent-gateway/tool-registry.js（AGENT_TOOL_ROWS，唯一权威）
 *   ② plugins/brainx-openclaw/runtime.js（BRAINX_OPENCLAW_TOOLS，签名转发层）
 *   ③ plugins/brainx-openclaw/openclaw.plugin.json（manifest contracts.tools）
 *   ④ deploy/openclaw/openclaw.production.json（tools.allow）
 *   ⑤ tests/fixtures/openclaw-production/plugin-contract.json（allowed_tools）
 * 另逐工具比对 ①↔② 的参数 schema（插件参数必须与网关白名单一致）。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { AGENT_TOOL_ROWS, createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import { BRAINX_OPENCLAW_TOOLS } from '../plugins/brainx-openclaw/runtime.js';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('plugins/brainx-openclaw/openclaw.plugin.json', root)));
const prodConfig = JSON.parse(await readFile(new URL('deploy/openclaw/openclaw.production.json', root)));
const fixture = JSON.parse(await readFile(new URL('tests/fixtures/openclaw-production/plugin-contract.json', root)));

const registryNames = AGENT_TOOL_ROWS.map((row) => row.name);
const runtimeNames = BRAINX_OPENCLAW_TOOLS.map((row) => row.name);

function diffSet(a, b, labelA, labelB) {
  const onlyA = a.filter((x) => !b.includes(x)).map((x) => `仅 ${labelA} 有 ${x}`);
  const onlyB = b.filter((x) => !a.includes(x)).map((x) => `仅 ${labelB} 有 ${x}`);
  return [...onlyA, ...onlyB];
}

test('US5: 对外四个接口面完全一致，且外露集合是 registry 权威集的子集', () => {
  // registry 是超集：gateway 可注册不对外的内部工具（如 brainx_send_candidate_resume，
  // openclaw-plugin 测试明确断言其不外露）；对外四面（插件 runtime/manifest/生产配置/契约 fixture）必须精确相等。
  const exposed = [
    ['plugin-runtime', runtimeNames],
    ['manifest', manifest.contracts.tools],
    ['production-config', prodConfig.tools.allow],
    ['contract-fixture', fixture.allowed_tools],
  ];
  const problems = [];
  for (let i = 0; i < exposed.length; i += 1) {
    for (let j = i + 1; j < exposed.length; j += 1) {
      problems.push(...diffSet(exposed[i][1], exposed[j][1], exposed[i][0], exposed[j][0]));
    }
    // 外露的每个工具必须在权威 registry 中注册
    for (const name of exposed[i][1]) {
      if (!registryNames.includes(name)) problems.push(`${exposed[i][0]} 外聊了 registry 未注册的工具 ${name}`);
    }
  }
  assert.deepEqual(problems, [], `接口面漂移：\n${problems.join('\n')}`);
  assert.equal(new Set(registryNames).size, registryNames.length, 'registry 工具名不得重复');
  // 已知内部工具（registry 有但刻意不外露）变化必须显式可见
  const internalOnly = registryNames.filter((name) => !runtimeNames.includes(name));
  assert.deepEqual(internalOnly, ['brainx_send_candidate_resume'],
    '内部工具清单变化需人工确认（registry 超集外延漂移）');
});

test('US5: 逐工具参数 schema——registry 与插件转发层一致', () => {
  const registry = createToolRegistry();
  const problems = [];
  for (const tool of BRAINX_OPENCLAW_TOOLS) {
    try {
      assert.deepEqual(registry.schema(tool.name), tool.parameters);
    } catch (e) {
      problems.push(`${tool.name}: ${e.message.split('\n')[0]}`);
    }
  }
  assert.deepEqual(problems, [], `参数 schema 漂移：\n${problems.join('\n')}`);
});
