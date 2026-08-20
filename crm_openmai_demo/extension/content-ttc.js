/**
 * content-ttc.js — 在 TTC（app.ttcadvisory.com）页面运行。
 * 职责：从 localStorage 探测 TTC JWT（ottin-jwt-token-v2，三段式），
 *       一旦发现有效 JWT 就发给 background 自动同步到本地 BrainX。
 * 探测策略：优先候选 key，再遍历全部 localStorage 找「三段式 + payload 可解析 + 含 exp」的值。
 */

// 候选 key（按可能性排序；ttcsdk/auth.js 注释里的 token 名）
const CANDIDATE_KEYS = [
  'ottin-jwt-token-v2',
  'ottin-jwt-token',
  'ottin_token_v2',
  'ottin_token',
  'ttc_jwt',
  'ttc_token',
  'jwt_token',
  'auth_token',
  'Authorization',
  'access_token',
];

let lastSent = ''; // 去重：同一 JWT 不重复同步

function looksLikeJwt(value) {
  if (typeof value !== 'string' || value.length < 40 || value.length > 8192) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return false;
  try {
    const payload = JSON.parse(atob(parts[1].replaceAll('-', '+').replaceAll('_', '/')));
    return Boolean(payload && payload.exp);
  } catch {
    return false;
  }
}

function findTtcJwt() {
  try {
    for (const key of CANDIDATE_KEYS) {
      const v = localStorage.getItem(key);
      if (looksLikeJwt(v)) return v;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (/jwt|token|auth/i.test(key)) {
        const v = localStorage.getItem(key);
        if (looksLikeJwt(v)) return v;
      }
    }
  } catch { /* 跨域/隐私模式读不到就跳过 */ }
  return '';
}

function syncOnce() {
  const jwt = findTtcJwt();
  if (!jwt || jwt === lastSent) return;
  lastSent = jwt;
  chrome.runtime.sendMessage({ type: 'SYNC_TTC_JWT', jwt }).catch(() => {});
}

// 页面加载后立即探测一次；之后每 4s 轮询（登录/刷新 JWT 后会自动捕获）
setTimeout(syncOnce, 1500);
setInterval(syncOnce, 4000);
