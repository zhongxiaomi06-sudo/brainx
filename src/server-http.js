import http from 'node:http';
import { normalize, sep } from 'node:path';

export const STATIC_MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

export const isPathInside = (base, fp) => {
  const normalizedBase = normalize(base);
  const normalizedPath = normalize(fp);
  const baseWithSep = normalizedBase.endsWith(sep) ? normalizedBase : normalizedBase + sep;
  return normalizedPath === normalizedBase || normalizedPath.startsWith(baseWithSep);
};

export const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

export const err = (res, code, codeStr, message) => {
  json(res, code, { error: { code: codeStr, message } });
};

export const safeJsonArray = (value, fallback = []) => {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

export const normalizeWorkbenchPreferences = (input = {}) => {
  const cleanId = (value) => String(value || '').trim().slice(0, 120);
  const tray = Array.isArray(input.tray)
    ? Array.from(new Set(input.tray.map(cleanId).filter(Boolean))).slice(0, 100)
    : [];
  const folders = Array.isArray(input.folders)
    ? input.folders.slice(0, 50).map((folder, index) => ({
      id: cleanId(folder?.id) || `folder-${index + 1}`,
      name: String(folder?.name || '').trim().slice(0, 80) || '未命名文件夹',
      jobIds: Array.isArray(folder?.jobIds)
        ? Array.from(new Set(folder.jobIds.map(cleanId).filter(Boolean))).slice(0, 200)
        : [],
    }))
    : [];
  return { tray, folders, folderMode: !!input.folderMode };
};

export const proxyFrontend = (req, res, target) => {
  const targetPath = req.url === '/login' || req.url?.startsWith('/login?')
    ? `/${req.url.slice('/login'.length)}`
    : req.url || '/';
  const proxy = http.request({
    hostname: target.host,
    port: target.port,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `${target.host}:${target.port}` },
  }, (upstream) => {
    res.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', (error) => {
    if (!res.headersSent) err(res, 502, 'FRONTEND_UNAVAILABLE', `前端服务不可用：${error.message}`);
    else res.destroy(error);
  });
  req.pipe(proxy);
};

export async function body(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text || '{}'); } catch { return null; }
}
