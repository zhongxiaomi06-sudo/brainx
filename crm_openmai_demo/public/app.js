(() => {
  const TOKEN_KEY = 'crm-openmai-demo-token'
  const EXPIRES_KEY = 'crm-openmai-demo-token-expires'
  const AUTH_STATE_KEY = 'crm-openmai-demo-auth-state'
  const ids = [
    'environment', 'auth-dot', 'auth-text', 'login-button', 'logout-button',
    'job-id', 'run-button', 'job-preview', 'job-title', 'job-meta', 'error',
    'spinner', 'status', 'result', 'session', 'copy-button',
    'feishu-dot', 'feishu-text', 'ttc-dot', 'ttc-text',
  ]
  const elements = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]))
  let config = null
  let running = false
  let runController = null
  let autoRunPending = false // ?job_id=xxx 打开时，登录完成后自动触发找人

  function tokenExpiresAt(token) {
    try {
      const payload = token.split('.')[1]
      const base64 = payload.replaceAll('-', '+').replaceAll('_', '/')
      return JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))).exp * 1000
    } catch {
      return 0
    }
  }

  function getToken() {
    const token = sessionStorage.getItem(TOKEN_KEY)
    const expiresAt = Number(sessionStorage.getItem(EXPIRES_KEY) || 0)
    if (!token || !expiresAt || Date.now() >= expiresAt) {
      clearToken()
      return ''
    }
    return token
  }

  function saveToken(token, expiresAt) {
    const resolvedExpiry = Number(expiresAt) || tokenExpiresAt(token)
    if (!resolvedExpiry || resolvedExpiry <= Date.now()) throw new Error('登录凭证已过期')
    sessionStorage.setItem(TOKEN_KEY, token)
    sessionStorage.setItem(EXPIRES_KEY, String(resolvedExpiry))
    renderAuth()
  }

  function clearToken() {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(EXPIRES_KEY)
    renderAuth()
  }

  function renderAuth() {
    const token = sessionStorage.getItem(TOKEN_KEY)
    const expiresAt = Number(sessionStorage.getItem(EXPIRES_KEY) || 0)
    const loggedIn = Boolean(token && expiresAt > Date.now())
    elements['auth-dot'].classList.toggle('online', loggedIn)
    elements['auth-text'].textContent = loggedIn
      ? `已登录，凭证有效至 ${new Date(expiresAt).toLocaleString('zh-CN')}`
      : '尚未登录'
    elements['logout-button'].disabled = !loggedIn || running
    elements['run-button'].disabled = !loggedIn || running
    elements['login-button'].disabled = running
    if (autoRunPending && loggedIn && !running) {
      autoRunPending = false
      run()
    }
  }

  function randomState() {
    const values = new Uint8Array(16)
    crypto.getRandomValues(values)
    return [...values].map((value) => value.toString(16).padStart(2, '0')).join('')
  }

  function buildAuthUrl(state) {
    const url = new URL(config.authUrl)
    url.searchParams.set('callback_url', `${window.location.origin}/`)
    url.searchParams.set('state', state)
    url.searchParams.set('auto', '1')
    return url
  }

  function handleRedirectCallback() {
    const url = new URL(window.location.href)
    const token = url.searchParams.get('token')
    const expiresAt = url.searchParams.get('expires_at')
    const returnedState = url.searchParams.get('state')
    if (!token) return false
    const expectedState = sessionStorage.getItem(AUTH_STATE_KEY)
    if (!expectedState || returnedState !== expectedState) throw new Error('登录回调 state 校验失败')
    saveToken(token, expiresAt)
    sessionStorage.removeItem(AUTH_STATE_KEY)
    for (const key of ['token', 'expires_at', 'state', 'callback_url']) url.searchParams.delete(key)
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    return true
  }

  function popupLogin() {
    const state = randomState()
    sessionStorage.setItem(AUTH_STATE_KEY, state)
    const authUrl = buildAuthUrl(state)
    const popup = window.open(
      authUrl,
      'crm-openmai-auth',
      'width=520,height=680,menubar=no,toolbar=no,location=no,status=no',
    )
    if (!popup) {
      window.location.href = authUrl.toString()
      return
    }
    const authOrigin = new URL(config.authUrl).origin
    const listener = (event) => {
      if (event.origin !== authOrigin || event.source !== popup) return
      if (event.data?.type === 'AUTH_SUCCESS' && event.data.token) {
        saveToken(event.data.token, event.data.expiresAt || event.data.expires_at)
        cleanup()
      } else if (event.data?.type === 'AUTH_CANCEL') {
        showError('已取消登录')
        cleanup()
      }
    }
    const timer = setInterval(() => popup.closed && cleanup(), 500)
    const cleanup = () => {
      window.removeEventListener('message', listener)
      clearInterval(timer)
      if (!popup.closed) popup.close()
    }
    window.addEventListener('message', listener)
  }

  function showError(message = '') {
    elements.error.textContent = message
    elements.error.classList.toggle('visible', Boolean(message))
  }

  function setRunning(value) {
    running = value
    elements.spinner.classList.toggle('visible', value)
    elements['job-id'].disabled = value
    renderAuth()
  }

  function renderJob(job) {
    elements['job-title'].textContent = `${job.name || '未命名职位'} · ${job.unique_id}`
    const parts = [job.company_name, ...(job.cities || []), job.salary, job.status_text].filter(Boolean)
    elements['job-meta'].textContent = parts.join(' · ')
    elements['job-preview'].classList.add('visible')
  }

  function renderResult(content, append = false) {
    const current = elements.result.classList.contains('empty') ? '' : elements.result.textContent
    const next = append ? `${current}${content}` : content
    elements.result.textContent = next
    elements.result.classList.toggle('empty', !next)
    elements['copy-button'].disabled = !next
  }

  function parseSseFrame(frame) {
    const lines = frame.split('\n')
    const event = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message'
    const data = lines.filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n')
    if (!data) return null
    try {
      return { event, payload: JSON.parse(data) }
    } catch {
      return null
    }
  }

  function applyEvent(message) {
    if (!message) return
    const { event, payload } = message
    if (event === 'status') elements.status.textContent = payload.message
    if (event === 'job') renderJob(payload.job)
    if (event === 'session') elements.session.textContent = `OpenMai session_id：${payload.sessionId}`
    if (event === 'chunk') renderResult(payload.content || '', true)
    if (event === 'complete') {
      renderResult(payload.result || '')
      elements.status.textContent = '已完成'
      if (payload.sessionId) elements.session.textContent = `OpenMai session_id：${payload.sessionId}`
    }
    if (event === 'error') throw new Error(payload.message || '执行失败')
  }

  async function consumeSse(response) {
    if (!response.body) throw new Error('本地 Demo 未返回结果流')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replaceAll('\r\n', '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        applyEvent(parseSseFrame(buffer.slice(0, boundary)))
        buffer = buffer.slice(boundary + 2)
        boundary = buffer.indexOf('\n\n')
      }
    }
    applyEvent(parseSseFrame(buffer + decoder.decode()))
  }

  async function run() {
    const token = getToken()
    const jobId = elements['job-id'].value.trim()
    if (!token) return showError('请先完成飞书登录')
    if (!jobId) return showError('请输入 CRM job_id')
    showError()
    elements['job-preview'].classList.remove('visible')
    elements.session.textContent = ''
    renderResult('')
    elements.status.textContent = '正在启动…'
    setRunning(true)
    runController = new AbortController()
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId }),
        signal: runController.signal,
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        throw new Error(body.message || `本地 Demo 请求失败（HTTP ${response.status}）`)
      }
      await consumeSse(response)
    } catch (error) {
      if (error?.name !== 'AbortError') {
        showError(error?.message || '执行失败')
        elements.status.textContent = '执行失败'
      }
    } finally {
      setRunning(false)
      runController = null
    }
  }

  async function loadCredentialStatus() {
    try {
      const feishu = await fetch('/api/session/status', { cache: 'no-store' }).then((r) => r.json())
      elements['feishu-dot'].classList.toggle('online', feishu.exists)
      elements['feishu-text'].textContent = feishu.exists
        ? '飞书登录态：已就绪（.state.enc）'
        : '飞书登录态：未生成（先扫码一次）'
    } catch {
      elements['feishu-text'].textContent = '飞书登录态：查询失败'
    }
    try {
      const ttc = await fetch('/api/ttc/status?consultant_id=felix', { cache: 'no-store' }).then((r) => r.json())
      if (ttc.proxy === false) {
        elements['ttc-dot'].className = 'dot'
        elements['ttc-text'].textContent = `TTC：本地 BrainX 未启动（${ttc.message || '连不上 127.0.0.1:3100'}）`
      } else if (ttc.connected) {
        elements['ttc-dot'].classList.add('online')
        elements['ttc-text'].textContent = `TTC 已连接：${ttc.ttc_user_name || '顾问'} · 有效至 ${new Date(ttc.expires_at).toLocaleString('zh-CN')}`
      } else {
        elements['ttc-dot'].className = 'dot'
        elements['ttc-text'].textContent = 'TTC 未连接：扫码登录后扩展自动同步'
      }
    } catch {
      elements['ttc-text'].textContent = 'TTC：查询失败'
    }
  }

  async function init() {
    const response = await fetch('/api/config', { cache: 'no-store' })
    if (!response.ok) throw new Error('无法读取 Demo 配置')
    config = await response.json()
    elements.environment.textContent = config.environment === 'production' ? '生产环境' : '集成环境'
    handleRedirectCallback()
    renderAuth()
    loadCredentialStatus()
    // ?job_id=xxx：自动填入并（已登录时）立即自动开始找人；未登录则登录完成后自动触发
    const autoJobId = new URLSearchParams(window.location.search).get('job_id')
    if (autoJobId) {
      elements['job-id'].value = autoJobId
      if (getToken()) run()
      else autoRunPending = true
    }
  }

  elements['login-button'].addEventListener('click', () => { showError(); popupLogin() })
  elements['logout-button'].addEventListener('click', clearToken)
  elements['run-button'].addEventListener('click', run)
  elements['job-id'].addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !elements['run-button'].disabled) run()
  })
  elements['copy-button'].addEventListener('click', () => {
    navigator.clipboard.writeText(elements.result.textContent || '').catch(() => showError('复制失败'))
  })
  window.addEventListener('beforeunload', () => runController?.abort())
  init().catch((error) => showError(error?.message || 'Demo 初始化失败'))
})()
