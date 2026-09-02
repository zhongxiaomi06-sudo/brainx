/** mcp-write-guard.test.mjs — B 档安全硬前置（测试先行）。
 *
 * 权威契约: docs/2026-09-02-gap-and-next-actions.md B 档 + 工具外露白名单 §4；
 * 三条守门：①黑名单工具（brainx_sync_now/brainx_talent）不出现在 tools/list；
 * ②tools/call 命中黑名单返回显式错误、绝不执行（sync_now 默认参数会刷库）；
 * ③brainx_record_outcome 必须过 jobVisibleTo（与其他 5 个跨职位工具对齐，
 *   修复前可给任意职位录结果）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const now = new Date().toISOString();

/** 预置库：一个与 felix 无关的职位 pj_far + 一个有关系（TEAM_SHARED）的职位 pj_near。 */
function seedDb(dbPath) {
  const db = openDb(dbPath);
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES ('sr_test', 'felix', 'fixture', ?, 'h', ?)`).run(now, now);
  const insJob = db.prepare(`INSERT INTO job_facts
    (project_id, company, role, captured_at, sync_id, raw_json, updated_at)
    VALUES (?, '测试公司', '测试岗位', ?, 'sr_test', '{}', ?)`);
  insJob.run('pj_far', now, now);
  insJob.run('pj_near', now, now);
  db.prepare(`INSERT INTO job_memberships (consultant_id, project_id, relation, source, valid_from)
    VALUES ('felix', 'pj_near', 'TEAM_SHARED', 'test', ?)`).run(now);
  db.close();
}

/** 起 MCP 子进程指向预置库。 */
function mcpClient(dbPath) {
  const child = spawn('node', [join(ROOT, 'mcp', 'server.mjs')], {
    env: { ...process.env, BRAINX_DB: dbPath },
    stdio: ['pipe', 'pipe', 'ignore'],
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
    // 30s：本机 FS 代理环境下 server.mjs 冷启动实测 ~10s（node_modules + 31 迁移 + seed），
    // 8s 会误杀（既有 tests/mcp.test.mjs 在本环境同样超时，非逻辑回归）。
    setTimeout(() => reject(new Error(`timeout waiting ${method}`)), 30000);
  });
  const close = () => child.kill();
  return { call, close };
}

function withClient(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brainx-guard-'));
    const dbPath = join(dir, 't.db');
    seedDb(dbPath);
    const c = mcpClient(dbPath);
    try { await fn(c, dbPath); } finally { c.close(); rmSync(dir, { recursive: true, force: true }); }
  };
}

test('B1: tools/list 不含黑名单工具 brainx_sync_now / brainx_talent', withClient(async (c) => {
  const r = await c.call('tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  assert.ok(!names.includes('brainx_sync_now'), `sync_now 不得外露，实际: ${names.join(',')}`);
  assert.ok(!names.includes('brainx_talent'), 'talent（无 cid 隔离）不得外露');
  assert.ok(names.includes('brainx_engage'), '正常工具不受黑名单影响');
}));

test('B2: tools/call 命中黑名单返回显式错误，默认参数绝不执行（防刷库）', withClient(async (c) => {
  const r = await c.call('tools/call', {
    name: 'brainx_sync_now',
    arguments: { consultant_id: 'felix' }, // 默认 source='fixture' + dry_run=false
  });
  assert.ok(r.error, '黑名单工具必须返回 JSON-RPC error 而非执行');
  assert.match(r.error.message, /blocked/i);
}));

test('B3: record_outcome 对无关系职位返回 NOT_FOUND（jobVisibleTo 守门）', withClient(async (c) => {
  const r = await c.call('tools/call', {
    name: 'brainx_record_outcome',
    arguments: { consultant_id: 'felix', project_id: 'pj_far', stage: 'OFFER', idempotency_key: 'k_far' },
  });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.error, 'NOT_FOUND', '存在但无关的职位必须拒绝（fail-closed）');
}));

test('B4: record_outcome 对有关系职位正常录入（守门不误伤）', withClient(async (c) => {
  const r = await c.call('tools/call', {
    name: 'brainx_record_outcome',
    arguments: { consultant_id: 'felix', project_id: 'pj_near', stage: 'OFFER', idempotency_key: 'k_near' },
  });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.ok, true, `有关系职位应放行，实际: ${JSON.stringify(out)}`);
}));

test('B5: 静态扫描——四个跨职位写工具的 run 块都必须调 jobVisibleTo（防再漏守门）', () => {
  const src = readFileSync(join(ROOT, 'mcp', 'server.mjs'), 'utf8');
  for (const tool of ['brainx_engage', 'brainx_record_progress', 'brainx_terminal_result', 'brainx_record_outcome']) {
    const m = src.match(new RegExp(`${tool}:\\s*\\{[\\s\\S]{0,900}?run:`));
    assert.ok(m, `${tool} 定义应存在`);
    const block = src.slice(m.index, m.index + 1200);
    assert.ok(
      block.includes('jobVisibleTo'),
      `${tool} 的 run 实现必须包含 jobVisibleTo 守门`,
    );
  }
});

test('E3-MCP: tools/list 含 brainx_confirm_facts，黑名单仍被过滤', withClient(async (c) => {
  const r = await c.call('tools/list', {});
  const names = r.result.tools.map((t) => t.name);
  assert.ok(names.includes('brainx_confirm_facts'), 'E3 确认闭环工具应外露');
  assert.ok(!names.includes('brainx_sync_now'), '黑名单不受新工具影响');
}));

test('E3-MCP: 经 MCP 确认草稿 → job_facts 落库（draft→权威表全链）', withClient(async (c, dbPath) => {
  // 用预置库 seed 一条 pending 草稿（走 E1 全链路：网关→账本→消费者）
  const db = openDb(dbPath);
  const { registerChatContext } = await import('../src/gateway/chat-contexts.js');
  const { processLarkEvent } = await import('../src/gateway/lark-gateway.js');
  const { consumeJobExtract } = await import('../src/job-extract/index.js');
  registerChatContext(db, { chat_id: 'oc_mcp', bot_mode: 'ALL' });
  processLarkEvent(db, {
    message_id: 'om_mcp_e3', chat_id: 'oc_mcp', open_id: 'ou_u',
    mentions: [], message_type: 'text',
    create_time: '2026-09-02T12:00:00+08:00', body: { text: '煌炎科技急招产品经理，HC 1' },
  });
  const ev = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?').get('lark:message:om_mcp_e3');
  consumeJobExtract(db, ev.event_id);
  const draft = db.prepare('SELECT * FROM job_facts_drafts WHERE message_id=?').get('om_mcp_e3');
  db.close();

  const r = await c.call('tools/call', {
    name: 'brainx_confirm_facts',
    arguments: { consultant_id: 'felix', draft_id: draft.draft_id },
  });
  const out = JSON.parse(r.result.content[0].text);
  assert.equal(out.ok, true, JSON.stringify(out));

  const verify = openDb(dbPath);
  const job = verify.prepare('SELECT * FROM job_facts WHERE project_id=?').get(out.project_id);
  assert.ok(job, 'job_facts 应有权威行');
  assert.equal(job.company, '煌炎科技');
  assert.equal(verify.prepare('SELECT status FROM job_facts_drafts WHERE draft_id=?').get(draft.draft_id).status, 'confirmed');
  verify.close();
}));

test('B6: brainx_recommend_run 60s 内第二次调用 → rate_limited', withClient(async (c) => {
  const first = await c.call('tools/call', {
    name: 'brainx_recommend_run', arguments: { consultant_id: 'felix' },
  });
  const firstOut = JSON.parse(first.result.content[0].text);
  assert.ok(!firstOut.error || firstOut.error !== 'rate_limited', `首次调用不应被限流: ${JSON.stringify(firstOut)}`);
  const second = await c.call('tools/call', {
    name: 'brainx_recommend_run', arguments: { consultant_id: 'felix' },
  });
  const secondOut = JSON.parse(second.result.content[0].text);
  assert.equal(secondOut.error, 'rate_limited', '60s 内第二次必须被限流');
  assert.ok(secondOut.retry_after_ms > 0);
}));
