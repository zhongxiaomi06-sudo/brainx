/**
 * brainx-openmai.mjs — OpenMai 自动找人执行器（agent/CLI 可调用）。
 *
 * 用已托管的 TTC JWT（ttcsdk ttc_tokens）读取 CRM 职位并调用 OpenMai 找人：
 *   - --job-id <id>   指定 CRM job_id（唯一 ID）
 *   - --latest        从 job_facts 取最近同步的职位
 *   - --search <词>   从 job_facts 按公司/岗位名模糊搜索（取首条）
 *   - --ask "<补充>"  自然语言补充指令（如"重点看北京、5年+经验"）
 *   - --consultant <id> 凭证归属顾问（默认 felix）
 *   - --list          只列出 job_facts 里的职位，不找人
 *
 * 用法：
 *   node bin/brainx-openmai.mjs --latest --ask "找猎头背景的候选人"
 *   node bin/brainx-openmai.mjs --search "游戏" --consultant felix
 *   node bin/brainx-openmai.mjs --list
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../src/db.js';
import { getValidTtcJwt, markTtcReauth } from '../src/ttcsdk/auth.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ??= m[2];
  }
} catch { /* ignore */ }

const API_BASE = process.env.BRAINX_TTC_API_BASE || 'https://api.ttcadvisory.com';
const OPENMAI_BASE = process.env.BRAINX_OPENMAI_BASE || 'https://gateway.ttcadvisory.com';
const CRM_TIMEOUT = 15_000;
const OPENMAI_TIMEOUT = 12 * 60_000;
const POLL_TIMEOUT = 35 * 60_000;

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const val = (k, d = '') => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] ?? d : d; };
const consultant = val('--consultant', 'felix');
const ask = val('--ask', '');

function usage() {
  console.log(`用法：
  node bin/brainx-openmai.mjs --job-id <id> [--ask "补充指令"] [--consultant felix]
  node bin/brainx-openmai.mjs --latest [--ask "补充指令"] [--consultant felix]
  node bin/brainx-openmai.mjs --search <关键词> [--ask "补充指令"] [--consultant felix]
  node bin/brainx-openmai.mjs --list`);
  process.exit(has('--help') ? 0 : 1);
}

async function ttcFetch(path, jwt, method = 'POST', body = undefined, timeoutMs = CRM_TIMEOUT) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  if (resp.status === 401 || resp.status === 403) throw new Error('TTC 凭证失效（401/403）');
  if (!resp.ok) throw new Error(`TTC HTTP ${resp.status}：${data.message || data.msg || ''}`);
  if (data.code !== 0) throw new Error(`TTC code=${data.code} ${data.msg || ''}`.slice(0, 200));
  return data.data;
}

async function fetchCrmJob(jwt, jobId) {
  const data = await ttcFetch('/api/crm/v1/openmai/jobs/detail', jwt, 'POST', {
    unique_ids: [jobId], summary_chars: 1200,
  });
  const job = data?.jobs?.[0];
  if (!job) throw new Error('职位不存在，或当前顾问无权查看该职位');
  return job;
}

function buildPrompt(job, extraAsk) {
  const lines = [
    '请根据下面的职位描述找人：',
    '[',
    `职位 ID：${job.unique_id}`,
    `职位名称：${job.name || ''}`,
    `工作城市：${Array.isArray(job.cities) ? job.cities.join('、') : ''}`,
    `薪酬范围：${job.salary || ''}`,
    `人选画像：${job.analytics_summary || ''}`,
    `职位描述：${job.description_summary || ''}`,
    ']',
  ];
  if (extraAsk) lines.push(`补充要求：${extraAsk}`);
  lines.push('请使用 OpenMai 现有的找人能力搜索匹配候选人，并返回本次会话结果。');
  return lines.join('\n');
}

async function callOpenMai(jwt, job, extraAsk) {
  const controller = new AbortController();
  const resp = await fetch(`${OPENMAI_BASE}/api/openmai/v1/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content: buildPrompt(job, extraAsk), job_id: job.unique_id }),
    signal: controller.signal,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let payload = {}; try { payload = JSON.parse(text); } catch { /* ignore */ }
    if (resp.status === 401 || resp.status === 403) throw new Error('OpenMai 凭证失效（401/403）');
    throw new Error(`OpenMai HTTP ${resp.status}：${payload.message || payload.msg || payload.error || ''}`);
  }
  // 累积 SSE 结果
  const state = { sessionId: '', messageId: '', result: '', deferred: false };
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of resp.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replaceAll('\r\n', '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const data = frame.split('\n').filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart()).join('\n');
      if (!data) continue;
      let payload; try { payload = JSON.parse(data); } catch { continue; }
      if (payload?.type === 'session_created') state.sessionId = payload.session_id;
      if (payload?.type === 'assistant_content_replaced') state.result = payload.content || '';
      if (payload?.role === 'assistant' && payload?.done === false && payload.content) state.result += payload.content;
      if (payload?.done === true) {
        state.messageId = payload.message_id || state.messageId;
        state.deferred = payload.deferred === true;
        if (typeof payload.canonical_content === 'string') state.result = payload.canonical_content;
      }
      if (payload?.error) throw new Error(payload.message || payload.error || 'OpenMai 执行失败');
    }
  }
  buffer += decoder.decode();
  const tail = buffer.split('\n').filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart()).join('\n');
  if (tail) { try { const p = JSON.parse(tail); if (p?.done === true) state.deferred = p.deferred === true; } catch { /* ignore */ } }
  if (state.deferred) state.result = await pollAsyncResult(jwt, state);
  if (!state.result) state.result = await loadPersisted(jwt, state);
  if (!state.result) throw new Error('OpenMai 已结束但没有读取到会话结果');
  return state.result;
}

async function pollAsyncResult(jwt, state) {
  const startedAt = Date.now();
  let attempt = 0;
  while (Date.now() - startedAt < POLL_TIMEOUT) {
    await new Promise((r) => setTimeout(r, [1000, 2000, 5000][Math.min(attempt, 2)]));
    const url = `${OPENMAI_BASE}/api/openmai/v1/sessions/${encodeURIComponent(state.sessionId)}/messages/${encodeURIComponent(state.messageId)}/async-status`;
    const data = await ttcFetch(url, jwt, 'GET', undefined, 10_000);
    const message = data;
    if (message?.async_state === 'running' || message?.status === 2) { attempt += 1; continue; }
    if (message?.async_state === 'succeeded' || message?.status === 0) return message.content || '';
    throw new Error(message?.error_reason || `异步执行失败：${message?.async_state || 'unknown'}`);
  }
  throw new Error('等待 OpenMai 结果超时');
}

async function loadPersisted(jwt, state) {
  if (!state.sessionId) return '';
  const url = `${OPENMAI_BASE}/api/openmai/v1/sessions/${encodeURIComponent(state.sessionId)}/messages?page=1&page_size=50&tail=true`;
  const data = await ttcFetch(url, jwt, 'GET', undefined, 10_000);
  const messages = data?.data;
  if (!Array.isArray(messages)) return '';
  return [...messages].reverse().find((m) => m?.role === 'assistant' && m?.status === 0)?.content || '';
}

function listJobs(db) {
  return db.prepare(`SELECT project_id, company, role, city, active_state, captured_at
    FROM job_facts ORDER BY captured_at DESC LIMIT 50`).all();
}

function resolveJobId(db) {
  if (has('--job-id')) return val('--job-id');
  const jobs = listJobs(db);
  if (!jobs.length) throw new Error('job_facts 为空，先同步岗位（brainx-sync / adapter）');
  if (has('--latest')) return jobs[0].project_id;
  if (has('--search')) {
    const kw = val('--search').toLowerCase();
    const hit = jobs.find((j) => (j.company || '').toLowerCase().includes(kw) || (j.role || '').toLowerCase().includes(kw));
    if (!hit) throw new Error(`job_facts 里没找到含「${kw}」的职位`);
    return hit.project_id;
  }
  return jobs[0].project_id;
}

async function main() {
  if (has('--help') || (!has('--job-id') && !has('--latest') && !has('--search') && !has('--list'))) return usage();
  const db = openDb(join(ROOT, 'data/brainx.db'));
  if (has('--list')) {
    const jobs = listJobs(db);
    console.log(`job_facts 最近 ${jobs.length} 个职位：`);
    for (const j of jobs.slice(0, 30)) {
      console.log(`  ${j.project_id}  ${j.company || ''}｜${j.role || ''}  ${j.city || ''} [${j.active_state}] ${j.captured_at || ''}`);
    }
    return;
  }
  const jwt = getValidTtcJwt(db, consultant);
  if (!jwt) {
    console.error(`❌ ${consultant} 没有有效的 TTC 凭证——用浏览器扩展扫码同步，或粘贴 JWT 到凭证中心`);
    process.exit(1);
  }
  const jobId = resolveJobId(db);
  console.log(`[openmai] 顾问 ${consultant} · 职位 ${jobId}`);
  const job = await fetchCrmJob(jwt, jobId);
  console.log(`[openmai] 职位：${job.name || ''}（${job.company_name || ''}）${(job.cities || []).join('、')} ${job.salary || ''}`);
  console.log('[openmai] 调用 OpenMai 找人…');
  const result = await callOpenMai(jwt, job, ask);
  console.log('\n========== OpenMai 找人结果 ==========');
  console.log(result);
  console.log('======================================');
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
