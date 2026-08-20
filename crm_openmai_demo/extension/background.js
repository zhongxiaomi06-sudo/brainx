/**
 * background.js — 扩展 service worker。
 * 职责：接收 content script 的 JWT，POST 到本地 BrainX 同步端点；
 *       管理本地服务地址与顾问选择（storage）。
 */

const DEFAULT_LOCAL = 'http://127.0.0.1:3100';

async function getConfig() {
  const store = await chrome.storage.local.get(['localUrl', 'consultantId']);
  return {
    localUrl: String(store.localUrl || DEFAULT_LOCAL).replace(/\/+$/, ''),
    consultantId: String(store.consultantId || 'felix'),
  };
}

async function syncJwt(jwt) {
  const { localUrl, consultantId } = await getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(`${localUrl}/api/v1/ttc/ext-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jwt, consultant_id: consultantId }),
      signal: controller.signal,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      return { ok: false, message: data.message || `本地服务 HTTP ${resp.status}` };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, message: `连不上本地 BrainX（${localUrl}）：${e.message}` };
  } finally {
    clearTimeout(timer);
  }
}

async function pingLocal() {
  const { localUrl } = await getConfig();
  try {
    const resp = await fetch(`${localUrl}/api/v1/consultants`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
    const data = await resp.json();
    return { ok: true, consultants: data.items || [] };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

async function getStatus() {
  const { localUrl, consultantId } = await getConfig();
  try {
    const resp = await fetch(
      `${localUrl}/api/v1/ttc/status?consultant_id=${encodeURIComponent(consultantId)}`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (!resp.ok) return { ok: false, message: `HTTP ${resp.status}` };
    return { ok: true, status: await resp.json() };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SYNC_TTC_JWT') {
    syncJwt(message.jwt).then(sendResponse);
    return true; // 异步响应
  }
  if (message?.type === 'PING_LOCAL') {
    pingLocal().then(sendResponse);
    return true;
  }
  if (message?.type === 'GET_STATUS') {
    getStatus().then(sendResponse);
    return true;
  }
  return false;
});
