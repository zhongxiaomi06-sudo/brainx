/** quickfb.js — 推送卡片签名一键动作（忽略、接单并建群）。
 *
 * 背景：卡片按钮历来是纯 URL 深链（打开工作台才能操作），顾问不登录 UI 就
 * 没有任何反馈入口。一键链接把“忽略”和“接单并建群”直接做进卡片按钮；
 * 后者复用既有权限、确认、幂等建群和接单链路，不自动发起收费找人任务。
 *
 * 安全：链接带 HMAC-SHA256 签名（consultant|project|action|day），密钥走
 * env BRAINX_FEEDBACK_SECRET；当日/次日双窗口校验（跨时区点击宽容）。
 * 未配置密钥 → quickLink 返回 null（卡片不渲染按钮）、端点 503，fail-closed。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const QUICK_ACTIONS = { ignore: '忽略', launch: '接单并建群' };

function localDerivedSecret() {
  if (process.env.BRAINX_ALLOW_HTTP_LOOPBACK !== '1' || !process.env.BRAINX_DEV_AUTH) return '';
  try {
    const host = new URL(process.env.BRAINX_BASE_URL || '').hostname;
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return '';
  } catch { return ''; }
  return createHmac('sha256', process.env.BRAINX_DEV_AUTH)
    .update('brainx-feedback-v1', 'utf8').digest('hex');
}

// 正式环境必须显式配置独立密钥；只有明确开启的本机回环开发环境，才从已有
// 本地登录密钥做域隔离派生，避免每次重启临时换钥导致当天已发卡片全部失效。
const secret = () => process.env.BRAINX_FEEDBACK_SECRET || localDerivedSecret();

const sig = (cid, pid, action, day) =>
  createHmac('sha256', secret()).update(`${cid}|${pid}|${action}|${day}`).digest('hex').slice(0, 24);

/** 生成一键链接；未配密钥返回 null（卡片层据此省略按钮）。 */
export function quickLink(baseUrl, cid, pid, action, dayIso) {
  if (!secret() || !QUICK_ACTIONS[action]) return null;
  const day = dayIso.slice(0, 10);
  const q = new URLSearchParams({ consultant: cid, project: pid, action, day, sig: sig(cid, pid, action, day) });
  return `${String(baseUrl).replace(/\/+$/, '')}/api/v1/feedback/quick?${q}`;
}

/** 校验请求参数。today 为服务器当天 ISO（now()）；放行当天与前一天（推送常在夜间点击）。 */
export function verifyQuick({ consultant, project, action, day, sig: given }, today) {
  if (!secret()) return { ok: false, status: 503, error: '一键反馈未配置（BRAINX_FEEDBACK_SECRET）' };
  if (!consultant || !project || !QUICK_ACTIONS[action] || !day || !given) {
    return { ok: false, status: 400, error: '参数不完整' };
  }
  const days = [today.slice(0, 10),
                new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10)];
  if (!days.includes(day)) return { ok: false, status: 403, error: '链接已过期（仅当日/次日有效）' };
  const expect = Buffer.from(sig(consultant, project, action, day));
  const got = Buffer.from(String(given));
  if (expect.length !== got.length || !timingSafeEqual(expect, got)) {
    return { ok: false, status: 403, error: '签名无效' };
  }
  return { ok: true };
}

/** 点击后的极简结果页（飞书内置浏览器打开）。text 一律 HTML 转义（预埋 XSS 防护）。 */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function quickResultPage(okFlag, text) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,sans-serif;display:flex;min-height:80vh;align-items:center;justify-content:center;background:#f7f8fa">
<div style="text-align:center"><div style="font-size:48px">${okFlag ? '✅' : '⚠️'}</div>
<p style="color:#333;font-size:16px">${esc(text)}</p>
<p style="color:#999;font-size:12px">可关闭本页，已同步到 Brain X 工作台</p></div>`;
}
