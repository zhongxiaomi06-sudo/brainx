/** client-error.js — 浏览器端运行时错误上报路由（POST /api/v1/meta/client-error）。
 *
 * layout.tsx 内联探针与 ErrorBoundary 的接收端：白屏/资源 404/水合失败的事故特征源。
 * 免登录（出错时 session 可能也不可用）；只落聚合日志行 + guard 计数，不存业务数据。
 * 2026-08-25 mia 白屏事故后增设；从 server.js 拆出以控制主文件规模（质量门禁基线）。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { body, err, json } from './server-http.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function makeClientErrorRoute(guard) {
  return async (req, res) => {
    const b = await body(req);
    if (!b || typeof b.message !== 'string') return err(res, 400, 'BAD_BODY', '缺 message 字段');
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      kind: String(b.kind || 'error').slice(0, 40),
      message: b.message.slice(0, 500),
      source: String(b.source || '').slice(0, 300),
      line: Number(b.line) || 0,
      stack: String(b.stack || '').slice(0, 1000),
      url: String(b.url || '').slice(0, 300),
      chunk: !!b.chunk,
      component_stack: String(b.component_stack || '').slice(0, 1000),
    });
    try {
      mkdirSync(join(ROOT, 'logs'), { recursive: true });
      appendFileSync(join(ROOT, 'logs', 'frontend-errors.log'), line + '\n');
    } catch { /* 日志不可写不影响主流程 */ }
    guard.clientError();
    json(res, 200, { ok: true });
  };
}
