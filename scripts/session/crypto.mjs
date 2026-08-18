/**
 * crypto.mjs — 登录态静态加密（AES-256-GCM）。
 * 目的：storageState 里含你自己的 cookie/token，绝不能明文落盘到（可能是 Public 的）仓库里。
 * 密钥只走环境变量 SESSION_ENCRYPTION_KEY，不写进代码、不进 git。
 *
 * 生成一个密钥（32 字节 hex）：
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 * 然后放进 .env（已被 .gitignore 忽略）：
 *   SESSION_ENCRYPTION_KEY=<上面输出的 64 位 hex>
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';

function key() {
  const hex = process.env.SESSION_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('缺少 SESSION_ENCRYPTION_KEY（需 64 位 hex）。生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

/** 加密任意字符串 → 单个 base64 串（iv + authTag + 密文）。 */
export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密回原字符串。 */
export function decrypt(b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv(ALGO, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
