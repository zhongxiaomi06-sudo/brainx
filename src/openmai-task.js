/** openmai-task.js — 接单后自动触发 OpenMai 找人（异步任务 + 状态落库 openmai_results + SSE 定向通知）。
 *
 * 链路：顾问工作台点「接单」（engagement ACCEPT）→ startOpenmaiTask 后台异步执行
 *   （getValidTtcJwt → CRM job detail → OpenMai completions → 结果/错误落库）→
 *   bus.emit 定向推 openmai_result 事件 → 前端刷新展示候选人列表。
 *
 * 防重纪律（费用控制）：
 *   - 内存 running 集合 + DB 主键 (project_id, consultant_id) 双重防并发重入；
 *   - done 后默认复用结果（already_done），重新找人只能显式 force（rerun 接口）；
 *   - 无有效 TTC 凭证快速失败（failed + 引导提示），不空转。
 */
import { now, uuid } from './db.js';
import { getValidTtcJwt } from './ttcsdk/auth.js';

const API_BASE = process.env.BRAINX_TTC_API_BASE || 'https://api.ttcadvisory.com';
const OPENMAI_BASE = process.env.BRAINX_OPENMAI_API_BASE || 'https://gateway.ttcadvisory.com';
const CRM_TIMEOUT_MS = 15_000;
const OPENMAI_TIMEOUT_MS = 12 * 60_000;
const POLL_TIMEOUT_MS = 35 * 60_000;

const running = new Set(); // `${project_id}|${consultant_id}`

async function ttcFetch(path, jwt, method = 'POST', body = undefined, timeoutMs = CRM_TIMEOUT_MS) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  if (resp.status === 401 || resp.status === 403) throw new Error('TTC 凭证失效（401/403），请重新扫码同步');
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

function buildPrompt(job) {
  return [
    '请根据下面的职位描述找人：',
    '[',
    `职位 ID：${job.unique_id}`,
    `职位名称：${job.name || ''}`,
    `工作城市：${Array.isArray(job.cities) ? job.cities.join('、') : ''}`,
    `薪酬范围：${job.salary || ''}`,
    `人选画像：${job.analytics_summary || ''}`,
    `职位描述：${job.description_summary || ''}`,
    ']',
    '请使用 OpenMai 现有的找人能力搜索匹配候选人，并返回本次会话结果。',
  ].join('\n');
}

async function callOpenmai(jwt, job) {
  const resp = await fetch(`${OPENMAI_BASE}/api/openmai/v1/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content: buildPrompt(job), job_id: job.unique_id }),
    signal: AbortSignal.timeout(OPENMAI_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    let payload = {}; try { payload = JSON.parse(text); } catch { /* ignore */ }
    if (resp.status === 401 || resp.status === 403) throw new Error('OpenMai 凭证失效（401/403），请重新扫码同步');
    throw new Error(`OpenMai HTTP ${resp.status}：${payload.message || payload.msg || payload.error || ''}`);
  }
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
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, [1000, 2000, 5000][Math.min(attempt, 2)]));
    const url = `${OPENMAI_BASE}/api/openmai/v1/sessions/${encodeURIComponent(state.sessionId)}/messages/${encodeURIComponent(state.messageId)}/async-status`;
    const message = await ttcFetch(url, jwt, 'GET', undefined, 10_000);
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

/** 启动找人任务（接单后自动触发）。返回 { status: triggered|running|already_done|error, ... }。 */
export function startOpenmaiTask(db, bus, consultant_id, project_id, { force = false } = {}) {
  const key = `${project_id}|${consultant_id}`;
  const existing = db.prepare('SELECT status, started_at, finished_at FROM openmai_results WHERE project_id=? AND consultant_id=?')
    .get(project_id, consultant_id);
  if (running.has(key)) return { status: 'running', started_at: existing?.started_at };
  if (!force && existing?.status === 'done')
    return { status: 'already_done', finished_at: existing.finished_at };
  if (!force && existing?.status === 'failed' && Date.now() - Date.parse(existing.started_at || 0) < 60_000)
    return { status: 'error', message: '最近一次失败未超过 1 分钟，稍后再试或显式重新找人' };

  const jwt = getValidTtcJwt(db, consultant_id);
  if (!jwt) {
    const t = now();
    db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, error, started_at, finished_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(project_id, consultant_id) DO UPDATE SET status='failed', error=excluded.error,
        started_at=excluded.started_at, finished_at=excluded.finished_at`)
      .run(project_id, consultant_id, 'failed', '没有有效 TTC 凭证——请用浏览器扩展扫码同步', t, t);
    bus?.emit?.({ type: 'openmai_result', consultant_id, project_id, status: 'failed' });
    return { status: 'error', message: '没有有效 TTC 凭证——请用浏览器扩展扫码同步' };
  }

  const task_id = `om_${uuid().slice(0, 8)}`;
  const started_at = now();
  running.add(key);
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, task_id, started_at)
    VALUES (?,?, 'running', ?, ?)
    ON CONFLICT(project_id, consultant_id) DO UPDATE SET status='running', error=NULL, result_text=NULL,
      task_id=excluded.task_id, started_at=excluded.started_at, finished_at=NULL`)
    .run(project_id, consultant_id, task_id, started_at);

  (async () => {
    let status = 'failed';
    try {
      const job = await fetchCrmJob(jwt, project_id);
      const result = await callOpenmai(jwt, job);
      db.prepare(`UPDATE openmai_results SET status='done', result_text=?, finished_at=? WHERE project_id=? AND consultant_id=?`)
        .run(result, now(), project_id, consultant_id);
      status = 'done';
    } catch (e) {
      db.prepare(`UPDATE openmai_results SET status='failed', error=?, finished_at=? WHERE project_id=? AND consultant_id=?`)
        .run(String(e.message).slice(0, 500), now(), project_id, consultant_id);
    } finally {
      running.delete(key);
      bus?.emit?.({ type: 'openmai_result', consultant_id, project_id, status });
    }
  })();

  return { status: 'triggered', task_id, started_at };
}

/** 查找人状态/结果（只读安全视图）。 */
export function getOpenmaiResult(db, consultant_id, project_id) {
  const r = db.prepare('SELECT status, result_text, error, task_id, started_at, finished_at FROM openmai_results WHERE project_id=? AND consultant_id=?')
    .get(project_id, consultant_id);
  if (!r) return { status: 'none' };
  return r;
}
