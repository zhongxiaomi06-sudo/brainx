/** mcp.test.mjs — brainx-mcp stdio 服务器：握手/工具列表/调用/错误。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 起 MCP 子进程，发 NDJSON 帧，按 id 收集响应。 */
function mcpClient({ boundConsultantId = '', tenantId = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-mcp-'));
  const child = spawn('node', [join(ROOT, 'mcp', 'server.mjs')], {
    env: { ...process.env, BRAINX_DB: join(dir, 't.db'),
      ...(boundConsultantId ? { BRAINX_MCP_CONSULTANT_ID: boundConsultantId } : {}),
      ...(tenantId ? { BRAINX_MCP_TENANT_ID: tenantId } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) > -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let seq = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 8000);
  });
  const close = () => { child.kill(); rmSync(dir, { recursive: true, force: true }); };
  return { call, close };
}

test('MCP：initialize → tools/list → tools/call 全链', async () => {
  const c = mcpClient();
  try {
    // 握手
    const init = await c.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } });
    assert.equal(init.result.serverInfo.name, 'brainx-mcp');
    assert.ok(init.result.capabilities.tools);
    // initialized 是 notification：不应有响应（发了也不崩）
    c.call('notifications/initialized').catch(() => {}); // 会被 timeout reject，忽略

    // 工具列表
    const list = await c.call('tools/list');
    const names = list.result.tools.map((t) => t.name);
    for (const t of ['brainx_consultants', 'brainx_workbench', 'brainx_recommendations',
                     'brainx_opportunity', 'brainx_engage', 'brainx_replay',
                     'brainx_record_outcome', 'brainx_push_preview']) {
      assert.ok(names.includes(t), `缺工具 ${t}`);
    }
    assert.equal(names.includes('brainx_sync_now'), false, '高风险同步工具不得外露');

    // 花名册（openDb 自动播种）
    const cons = await c.call('tools/call', { name: 'brainx_consultants', arguments: {} });
    const roster = JSON.parse(cons.result.content[0].text);
    assert.deepEqual(roster.map((x) => x.consultant_id), ['felix', 'linda', 'mia', 'otto', 'shanon', 'wendy', 'york']);
    assert.equal(roster[0].open_id, undefined); // open_id 不出 MCP

    // 空库工作台：EMPTY 同步态
    const wb = await c.call('tools/call', { name: 'brainx_workbench', arguments: { consultant_id: 'mia' } });
    const model = JSON.parse(wb.result.content[0].text);
    assert.equal(model.consultant_id, 'mia');
    assert.equal(model.sync.state, 'EMPTY');
    assert.equal(model.watched_limit, 0);

    // 未知工具 → JSON-RPC error；未知方法同理
    const bad = await c.call('tools/call', { name: 'brainx_nope', arguments: {} });
    assert.equal(bad.error.code, -32601);
    const badMethod = await c.call('resources/list');
    assert.equal(badMethod.error.code, -32601);
  } finally {
    c.close();
  }
});

test('MCP：engage 写入路径（隔离库）+ 幂等', async () => {
  const c = mcpClient();
  try {
    await c.call('initialize', {});
    // 旧 WATCH 动作已下线，MCP 返回领域错误而非崩溃
    const r = await c.call('tools/call', { name: 'brainx_engage', arguments: {
      consultant_id: 'felix', project_id: 'P-NOPE', action: 'WATCH', idempotency_key: 'mcp:t1' } });
    const out = JSON.parse(r.result.content[0].text);
    assert.ok(out.ok === false || out.error, '不存在的职位不应成功');
  } finally {
    c.close();
  }
});

test('MCP：brainx_replay 信任收紧——consultant_id 缺失/未知均拒绝', async () => {
  const c = mcpClient();
  try {
    await c.call('initialize', {});
    // 缺失 consultant_id：不再按声明身份兜底放行
    const noCid = await c.call('tools/call', { name: 'brainx_replay', arguments: { decision_id: 'D-ANY' } });
    assert.equal(JSON.parse(noCid.result.content[0].text).error, 'UNKNOWN_CONSULTANT');
    // 未知 consultant_id：roster 校验拒绝
    const badCid = await c.call('tools/call', { name: 'brainx_replay', arguments: { decision_id: 'D-ANY', consultant_id: 'intruder' } });
    assert.equal(JSON.parse(badCid.result.content[0].text).error, 'UNKNOWN_CONSULTANT');
    // 花名册内身份：进入归属校验（空库返回 NOT_FOUND 而非越权数据）
    const goodCid = await c.call('tools/call', { name: 'brainx_replay', arguments: { decision_id: 'D-ANY', consultant_id: 'felix' } });
    assert.equal(JSON.parse(goodCid.result.content[0].text).error, 'NOT_FOUND');
  } finally {
    c.close();
  }
});

test('MCP：服务端绑定顾问后隐藏身份参数、自动注入并拒绝越权覆盖', async () => {
  const c = mcpClient({ boundConsultantId: 'felix' });
  try {
    await c.call('initialize', {});
    const list = await c.call('tools/list');
    const workbench = list.result.tools.find((tool) => tool.name === 'brainx_workbench');
    assert.ok(workbench);
    assert.equal(workbench.inputSchema.properties.consultant_id, undefined);
    assert.ok(!workbench.inputSchema.required.includes('consultant_id'));

    const own = await c.call('tools/call', { name: 'brainx_workbench', arguments: {} });
    assert.equal(JSON.parse(own.result.content[0].text).consultant_id, 'felix');

    const override = await c.call('tools/call', {
      name: 'brainx_workbench', arguments: { consultant_id: 'mia' },
    });
    assert.equal(override.error.code, -32602);
    assert.match(override.error.message, /cannot be overridden/);
  } finally {
    c.close();
  }
});

test('MCP：候选 shortlist 仅在顾问与租户双绑定时外露，且职位不可见时不碰人才库', async () => {
  const hidden = mcpClient({ boundConsultantId: 'mia' });
  try {
    await hidden.call('initialize', {});
    const list = await hidden.call('tools/list');
    assert.equal(list.result.tools.some((tool) => tool.name === 'brainx_candidate_shortlist'), false);
  } finally {
    hidden.close();
  }

  const exposed = mcpClient({ boundConsultantId: 'mia', tenantId: 'tenant_a' });
  try {
    await exposed.call('initialize', {});
    const list = await exposed.call('tools/list');
    const tool = list.result.tools.find((entry) => entry.name === 'brainx_candidate_shortlist');
    assert.ok(tool);
    assert.equal(tool.inputSchema.properties.consultant_id, undefined);
    assert.equal(tool.inputSchema.properties.tenant_id, undefined);
    assert.deepEqual(tool.inputSchema.required, ['job_id']);

    const result = await exposed.call('tools/call', {
      name: 'brainx_candidate_shortlist', arguments: { job_id: 'job_01' },
    });
    assert.equal(result.result.isError, undefined);
    assert.equal(JSON.parse(result.result.content[0].text).error, 'NOT_FOUND_OR_FORBIDDEN');
    assert.doesNotMatch(result.result.content[0].text, /BRAINX_MYSQL_PASSWORD|SELECT|ttc-rds/);
  } finally {
    exposed.close();
  }
});
