/** env.js — 零依赖 .env 加载（node>=20.6 原生 process.loadEnvFile）。
 * 必须作为每个入口的第一个 import（副作用先于 oauth.js 等读取 env 的模块）。
 * .env 永不提交（.gitignore）；BRAINX_FEISHU_APP_SECRET 等敏感值只走这里。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = process.env.BRAINX_ENV_FILE || join(ROOT, '.env');
if (existsSync(p) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(p);
  } catch (error) {
    // ENOENT 是常态（本地无 .env），忽略；但「文件存在却读不到」（EACCES 等）
    // 必须可见 —— 静默吞掉会让缺失的变量在很远的地方才炸：
    // 2026-09-11 felix 在项目群绑定失败，根因就是 brainx-agent-gateway 以 brainx
    // 用户运行、读不到 root:600 的 /opt/brainx/.env，BRAINX_BASE_URL 悄悄为空。
    if (error?.code !== 'ENOENT') {
      console.error(`[brainx] env: 无法加载 ${p}（${error?.code || error?.message}）；缺失的变量将按未配置处理`);
    }
  }
}

/** BRAINX_LARK_PROFILE：lark-cli 命名 profile。服务器多应用并存（Mia 个人应用 +
 * braintex的小机器人），brainx 的 lark-cli 调用一律显式 --profile 指定身份，
 * 不依赖默认 profile（默认位留给其他服务）。空 = 不传（本地开发兼容）。 */
export const larkProfileArgs = () => {
  const prof = process.env.BRAINX_LARK_PROFILE || '';
  return prof ? ['--profile', prof] : [];
};
