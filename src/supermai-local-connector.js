/** SuperMai/Sourcing 本地连接器：只访问本机 loopback，不接受任意远程地址。 */

const PLATFORMS = Object.freeze(['boss', 'maimai', 'liepin']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function localBase(value) {
  const url = new URL(String(value || 'http://127.0.0.1:8910'));
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    const error = new Error('SUPERMAI_LOCAL_BASE_INVALID');
    error.code = 'SUPERMAI_LOCAL_BASE_INVALID';
    throw error;
  }
  return url;
}

async function readJson(fetchImpl, base, path, timeoutMs) {
  const response = await fetchImpl(new URL(path, base), {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`SUPERMAI_LOCAL_HTTP_${response.status}`);
  return response.json();
}

async function postJson(fetchImpl, base, path, body, timeoutMs) {
  const response = await fetchImpl(new URL(path, base), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.message || `SUPERMAI_LOCAL_HTTP_${response.status}`);
  }
  return payload;
}

function safePlatforms(input) {
  const source = input?.platforms || input?.browsers || input || {};
  return Object.fromEntries(PLATFORMS.map((platform) => {
    const item = source[platform] || {};
    const loggedIn = item.logged_in === true ? true : item.logged_in === false ? false : null;
    return [platform, { running: item.running === true, logged_in: loggedIn }];
  }));
}

/** 返回可公开给当前用户的窄状态；不返回本地路径、端口、Cookie 或 token。 */
export async function supermaiLocalStatus({
  fetchImpl = fetch,
  baseUrl = process.env.BRAINX_SUPERMAI_LOCAL_BASE_URL || 'http://127.0.0.1:8910',
  timeoutMs = 1500,
} = {}) {
  try {
    const base = localBase(baseUrl);
    const health = await readJson(fetchImpl, base, '/api/v1/health', timeoutMs);
    if (health?.ok !== true) {
      return { available: false, error_code: 'SUPERMAI_DESKTOP_NOT_READY', platforms: safePlatforms() };
    }
    const chrome = await readJson(fetchImpl, base, '/api/v1/chrome/status', timeoutMs);
    return {
      available: true,
      version: String(health.version || '').slice(0, 80) || null,
      busy: health.busy === true,
      platforms: safePlatforms(chrome),
      error_code: null,
    };
  } catch (error) {
    return {
      available: false,
      error_code: error?.code === 'SUPERMAI_LOCAL_BASE_INVALID'
        ? error.code : 'SUPERMAI_DESKTOP_UNAVAILABLE',
      platforms: safePlatforms(),
    };
  }
}

/** 只允许启动内建招聘平台的官方登录页，不接受调用方提供 URL。 */
export async function launchSupermaiPlatform(platform, {
  fetchImpl = fetch,
  baseUrl = process.env.BRAINX_SUPERMAI_LOCAL_BASE_URL || 'http://127.0.0.1:8910',
  timeoutMs = 25_000,
} = {}) {
  if (!PLATFORMS.includes(platform)) {
    return { ok: false, error_code: 'SUPERMAI_PLATFORM_INVALID' };
  }
  try {
    await postJson(fetchImpl, localBase(baseUrl), '/api/v1/chrome/launch', { platform }, timeoutMs);
    return { ok: true, platform, user_action: 'COMPLETE_OFFICIAL_LOGIN' };
  } catch (error) {
    return { ok: false, error_code: error?.code === 'SUPERMAI_LOCAL_BASE_INVALID'
      ? error.code : 'SUPERMAI_DESKTOP_UNAVAILABLE' };
  }
}

export const SUPERMAI_PLATFORMS = PLATFORMS;
