/** session.js — HMAC 无状态 Cookie（补全文档 §14；OAuth 后绑定 open_id）。
 * 目的不是防人，是让每条事件有确定 actor。重启不失效（密钥落盘 data/.secret）。
 * payload = consultant_id.open_id.exp，签名防篡改；open_id 由 OAuth 回调写入。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_PATH = join(ROOT, 'data', '.secret');

export function sessionSecret() {
  if (!existsSync(SECRET_PATH)) {
    mkdirSync(dirname(SECRET_PATH), { recursive: true });
    writeFileSync(SECRET_PATH, randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return readFileSync(SECRET_PATH, 'utf8').trim();
}

export function signSession(consultant_id, open_id = '') {
  const exp = Date.now() + 7 * 86400000;
  // v2：各段 b64url 编码——consultant_id/open_id 含 '.' 时旧格式签发自锁（verify 恒 null）。
  const payload = ['v2', consultant_id, open_id, String(exp)]
    .map((x) => Buffer.from(x, 'utf8').toString('base64url')).join('.');
  const sig = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/** 校验通过返回 { consultant_id, open_id }，失败返回 null。兼容 v1 明文格式。 */
export function verifySession(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  let payload, consultant_id, open_id, exp, sig;
  if (parts.length === 5) { // v2：4 段 b64url + sig（首段解码后为 'v2' 标记）
    payload = parts.slice(0, 4).join('.');
    sig = parts[4];
    let v;
    try {
      [v, consultant_id, open_id, exp] = parts.slice(0, 4)
        .map((x) => Buffer.from(x, 'base64url').toString('utf8'));
    } catch { return null; }
    if (v !== 'v2') return null;
  } else if (parts.length === 4) {
    [consultant_id, open_id, exp, sig] = parts;
    payload = `${consultant_id}.${open_id}.${exp}`;
  } else return null;
  const expect = createHmac('sha256', sessionSecret()).update(payload).digest('hex');
  const got = Buffer.from(String(sig)), want = Buffer.from(expect);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (Date.now() > Number(exp)) return null;
  return { consultant_id, open_id };
}

export function cookieOf(req) {
  const m = /(?:^|;\s*)brainx_session=([^;]+)/.exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
