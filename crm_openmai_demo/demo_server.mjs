import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = parsePort(process.env.DEMO_PORT)
const HOST = '127.0.0.1'
const MAX_REQUEST_BYTES = 8 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const CRM_TIMEOUT_MS = 15_000
const OPENMAI_STREAM_TIMEOUT_MS = 12 * 60_000
const ASYNC_POLL_TIMEOUT_MS = 35 * 60_000

class DemoError extends Error {
  constructor(message, status = 500) {
    super(message)
    this.status = status
  }
}

function parsePort(value) {
  const parsed = Number(value || 3210)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
    throw new Error('DEMO_PORT 必须是 1024-65535 之间的整数')
  }
  return parsed
}

function resolveConfig() {
  const environment = String(process.env.DEMO_ENV || 'production').toLowerCase()
  const integration = environment === 'integration' || environment === 'int'
  return {
    environment: integration ? 'integration' : 'production',
    authUrl: process.env.DEMO_AUTH_URL || (integration
      ? 'https://int.ttcadvisory.com/auth/authorize'
      : 'https://app.ttcadvisory.com/auth/authorize'),
    crmBaseUrl: process.env.DEMO_CRM_API_BASE_URL || (integration
      ? 'https://api-int.ttcadvisory.com'
      : 'https://api.ttcadvisory.com'),
    openmaiBaseUrl: process.env.DEMO_OPENMAI_API_BASE_URL || (integration
      ? 'https://gateway-int.ttcadvisory.com'
      : 'https://gateway.ttcadvisory.com'),
  }
}

function setCommonHeaders(response) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
}

function sendJson(response, status, body) {
  setCommonHeaders(response)
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

function validateSameOrigin(request) {
  const origin = request.headers.origin
  if (!origin) return
  const allowed = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`])
  if (!allowed.has(origin)) throw new DemoError('请求来源不受信任', 403)
}

function getBearerToken(request) {
  const authorization = String(request.headers.authorization || '')
  if (!authorization.startsWith('Bearer ')) throw new DemoError('请先完成飞书登录', 401)
  const token = authorization.slice(7).trim()
  if (token.length < 32 || token.length > 8192 || !/^[A-Za-z0-9._-]+$/.test(token)) {
    throw new DemoError('登录凭证格式无效，请重新登录', 401)
  }
  return token
}

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new DemoError('请求内容过大', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new DemoError('请求 JSON 无效', 400)
  }
}

function validateJobId(value) {
  const jobId = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(jobId)) {
    throw new DemoError('CRM job_id 格式无效', 400)
  }
  return jobId
}

function openTimedFetch(url, options, timeoutMs, parentSignal) {
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parentSignal?.reason)
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('upstream timeout')), timeoutMs)
  const cleanup = () => {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
  return { promise: fetch(url, { ...options, signal: controller.signal }), cleanup }
}

async function readLimitedResponse(response) {
  if (!response.body) return ''
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > MAX_RESPONSE_BYTES) throw new DemoError('上游响应过大', 502)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchJson(url, options, timeoutMs, parentSignal) {
  const timed = openTimedFetch(url, options, timeoutMs, parentSignal)
  try {
    const response = await timed.promise
    const text = await readLimitedResponse(response)
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      throw new DemoError('上游返回了非 JSON 响应', 502)
    }
    if (!response.ok) throw upstreamHttpError(response.status, payload)
    return payload
  } catch (error) {
    throw normalizeFetchError(error)
  } finally {
    timed.cleanup()
  }
}

function normalizeFetchError(error) {
  if (error instanceof DemoError) return error
  if (error?.name === 'AbortError' || /timeout/i.test(String(error?.message))) {
    return new DemoError('上游接口调用超时', 504)
  }
  return new DemoError('无法连接上游接口', 502)
}

function upstreamHttpError(status, payload) {
  if (status === 401 || status === 403) {
    return new DemoError('登录凭证已失效或当前账号无权限', status)
  }
  const detail = payload?.message || payload?.msg || payload?.error
  return new DemoError(detail ? `上游接口失败：${detail}` : `上游接口失败（HTTP ${status}）`, 502)
}

function authHeaders(token, accept = 'application/json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
}

async function fetchCrmJob(config, token, jobId, signal) {
  const payload = await fetchJson(
    `${config.crmBaseUrl}/api/crm/v1/openmai/jobs/detail`,
    {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ unique_ids: [jobId], summary_chars: 1200 }),
    },
    CRM_TIMEOUT_MS,
    signal,
  )
  if (payload?.code !== 0) {
    throw new DemoError(payload?.message || payload?.msg || 'CRM 查询失败', 502)
  }
  const job = payload?.data?.jobs?.[0]
  if (!job) throw new DemoError('职位不存在，或当前登录顾问无权查看该职位', 404)
  return job
}

function buildOpenMaiPrompt(job) {
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
  ].join('\n')
}

async function writeSse(response, event, payload) {
  if (response.destroyed || response.writableEnded) return
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  if (!response.write(data)) await once(response, 'drain')
}

function startSse(response) {
  setCommonHeaders(response)
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()
}

function parseSseFrame(frame) {
  const data = frame.split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

async function consumeOpenMaiBody(body, onPayload) {
  if (!body) throw new DemoError('OpenMai 未返回结果流', 502)
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    buffer = buffer.replaceAll('\r\n', '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const payload = parseSseFrame(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (payload) await onPayload(payload)
      boundary = buffer.indexOf('\n\n')
    }
  }
  buffer += decoder.decode()
  const payload = parseSseFrame(buffer)
  if (payload) await onPayload(payload)
}

function updateCompletionState(state, payload) {
  if (payload?.type === 'session_created') state.sessionId = payload.session_id
  if (payload?.type === 'assistant_content_replaced') state.result = payload.content || ''
  if (payload?.role === 'assistant' && payload?.done === false && payload.content) {
    state.result += payload.content
  }
  if (payload?.done === true) {
    state.messageId = payload.message_id || state.messageId
    state.deferred = payload.deferred === true
    if (typeof payload.canonical_content === 'string') state.result = payload.canonical_content
  }
  if (payload?.error) {
    throw new DemoError(payload.message || payload.error || 'OpenMai 执行失败', 502)
  }
}

async function callOpenMai(config, token, job, response, signal) {
  const timed = openTimedFetch(
    `${config.openmaiBaseUrl}/api/openmai/v1/completions`,
    {
      method: 'POST',
      headers: authHeaders(token, 'text/event-stream'),
      body: JSON.stringify({ content: buildOpenMaiPrompt(job), job_id: job.unique_id }),
    },
    OPENMAI_STREAM_TIMEOUT_MS,
    signal,
  )
  const state = { sessionId: '', messageId: '', result: '', deferred: false }
  try {
    const upstream = await timed.promise
    if (!upstream.ok) {
      const text = await readLimitedResponse(upstream)
      let payload = {}
      try {
        payload = JSON.parse(text)
      } catch {
        // 使用 HTTP 状态构造错误。
      }
      throw upstreamHttpError(upstream.status, payload)
    }
    await consumeOpenMaiBody(upstream.body, async (payload) => {
      updateCompletionState(state, payload)
      if (payload?.content && payload?.done === false) {
        await writeSse(response, 'chunk', { content: payload.content })
      }
      if (payload?.type === 'session_created') {
        await writeSse(response, 'session', { sessionId: payload.session_id })
      }
      if (payload?.deferred === true) {
        await writeSse(response, 'status', { message: 'OpenMai 已转为异步执行，页面正在等待结果…' })
      }
    })
    return state
  } catch (error) {
    throw normalizeFetchError(error)
  } finally {
    timed.cleanup()
  }
}

function wait(delayMs, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    const abort = () => {
      clearTimeout(timer)
      reject(new DemoError('页面已关闭，执行已停止', 499))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function pollAsyncResult(config, token, state, signal) {
  if (!state.sessionId || !state.messageId) {
    throw new DemoError('OpenMai 异步结果缺少会话标识', 502)
  }
  const startedAt = Date.now()
  let attempt = 0
  while (Date.now() - startedAt < ASYNC_POLL_TIMEOUT_MS) {
    await wait([1000, 2000, 5000][Math.min(attempt, 2)], signal)
    const sessionId = encodeURIComponent(state.sessionId)
    const messageId = encodeURIComponent(state.messageId)
    const url = `${config.openmaiBaseUrl}/api/openmai/v1/sessions/${sessionId}/messages/${messageId}/async-status`
    const payload = await fetchJson(url, { headers: authHeaders(token) }, 10_000, signal)
    if (payload?.code !== 0 || !payload?.data) {
      throw new DemoError(payload?.message || 'OpenMai 异步状态查询失败', 502)
    }
    const message = payload.data
    if (message.async_state === 'running' || message.status === 2) {
      attempt += 1
      continue
    }
    if (message.async_state === 'succeeded' || message.status === 0) return message.content || ''
    throw new DemoError(message.error_reason || `OpenMai 异步执行失败：${message.async_state || 'unknown'}`, 502)
  }
  throw new DemoError('等待 OpenMai 结果超时', 504)
}

async function loadPersistedResult(config, token, state, signal) {
  if (!state.sessionId) return ''
  const url = `${config.openmaiBaseUrl}/api/openmai/v1/sessions/${encodeURIComponent(state.sessionId)}/messages?page=1&page_size=50&tail=true`
  const payload = await fetchJson(url, { headers: authHeaders(token) }, 10_000, signal)
  if (payload?.code !== 0) return ''
  const messages = payload?.data?.data
  if (!Array.isArray(messages)) return ''
  return [...messages].reverse()
    .find((item) => item?.role === 'assistant' && item?.status === 0)?.content || ''
}

async function runJobFlow(config, request, response) {
  validateSameOrigin(request)
  const token = getBearerToken(request)
  const body = await readJsonBody(request)
  const jobId = validateJobId(body?.jobId)
  const controller = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  startSse(response)
  await writeSse(response, 'status', { message: '正在读取 CRM 职位…' })
  const job = await fetchCrmJob(config, token, jobId, controller.signal)
  await writeSse(response, 'job', { job })
  await writeSse(response, 'status', { message: '职位读取成功，正在调用 OpenMai…' })
  const state = await callOpenMai(config, token, job, response, controller.signal)
  if (state.deferred) {
    state.result = await pollAsyncResult(config, token, state, controller.signal)
  }
  if (!state.result) state.result = await loadPersistedResult(config, token, state, controller.signal)
  if (!state.result) throw new DemoError('OpenMai 已结束，但没有读取到会话结果', 502)
  await writeSse(response, 'complete', { result: state.result, sessionId: state.sessionId })
  response.end()
}

async function loadAssets() {
  return new Map([
    ['/', { type: 'text/html; charset=utf-8', body: await readFile(join(ROOT, 'public/index.html')) }],
    ['/app.js', { type: 'text/javascript; charset=utf-8', body: await readFile(join(ROOT, 'public/app.js')) }],
  ])
}

function serveAsset(response, asset) {
  setCommonHeaders(response)
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
      "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'",
  )
  response.writeHead(200, { 'Content-Type': asset.type })
  response.end(asset.body)
}

async function handleRequest(config, assets, request, response) {
  const path = new URL(request.url || '/', `http://${HOST}:${PORT}`).pathname
  if (request.method === 'GET' && assets.has(path)) return serveAsset(response, assets.get(path))
  if (request.method === 'GET' && path === '/api/config') {
    return sendJson(response, 200, { environment: config.environment, authUrl: config.authUrl })
  }
  // —— 凭证中心：飞书登录态（.state.enc）状态 + TTC 连接状态（转发 brainx 3100）——
  if (request.method === 'GET' && path === '/api/session/status') {
    const stateFile = join(ROOT, '..', 'scripts', 'session', '.state.enc')
    return sendJson(response, 200, { exists: existsSync(stateFile) })
  }
  if (request.method === 'GET' && path === '/api/ttc/status') {
    try {
      const url = new URL(request.url || '/', `http://${HOST}:${PORT}`)
      const consultantId = url.searchParams.get('consultant_id') || 'felix'
      const resp = await fetch(
        `http://127.0.0.1:3100/api/v1/ttc/status?consultant_id=${encodeURIComponent(consultantId)}`,
        { signal: AbortSignal.timeout(5000) },
      )
      const data = await resp.json()
      return sendJson(response, 200, { proxy: true, ...data })
    } catch (e) {
      return sendJson(response, 502, { proxy: false, message: `连不上 BrainX（127.0.0.1:3100）：${e.message}` })
    }
  }
  if (request.method === 'POST' && path === '/api/run') {
    try {
      await runJobFlow(config, request, response)
    } catch (error) {
      const normalized = error instanceof DemoError ? error : new DemoError('Demo 执行失败')
      if (!response.headersSent) return sendJson(response, normalized.status, { message: normalized.message })
      await writeSse(response, 'error', { message: normalized.message })
      response.end()
    }
    return
  }
  sendJson(response, 404, { message: 'Not Found' })
}

async function main() {
  const config = resolveConfig()
  const assets = await loadAssets()
  const server = createServer((request, response) => {
    handleRequest(config, assets, request, response).catch((error) => {
      process.stderr.write(`Demo 请求处理失败：${error?.message || 'unknown'}\n`)
      if (!response.headersSent) sendJson(response, 500, { message: 'Demo 请求处理失败' })
      else response.destroy()
    })
  })
  server.requestTimeout = 36 * 60_000
  server.listen(PORT, HOST, () => {
    process.stdout.write(`CRM → OpenMai Demo 已启动：http://${HOST}:${PORT}\n`)
    process.stdout.write(`环境：${config.environment}\n`)
  })
}

main().catch((error) => {
  process.stderr.write(`Demo 启动失败：${error?.message || 'unknown'}\n`)
  process.exitCode = 1
})
