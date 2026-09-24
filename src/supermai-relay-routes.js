/** SuperMai 桌面 relay HTTP 边界。开放端点全部使用一次性配对码、设备 token 或任务 token 自鉴权。 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { productionBaseUrl } from './brainx-deep-links.js';
import { body, err, json } from './server-http.js';
import { zipExecutable } from './zip-single-file.js';
import {
  authenticateSupermaiDevice,
  claimSupermaiPairCode,
  createSupermaiPairCode,
  finishSupermaiTask,
  ingestSupermaiResults,
  pollSupermaiRelay,
  reportSupermaiRelay,
  revokeSupermaiDevice,
} from './supermai-relay.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONNECTOR_PATH = join(ROOT, 'bin', 'brainx-supermai-connector.mjs');

export const SUPERMAI_RELAY_OPEN_ROUTES = new Set([
  'POST /api/v1/supermai/pair/claim',
  'POST /api/v1/supermai/relay/poll',
  'POST /api/v1/supermai/relay/report',
  'GET /api/v1/supermai/connector/source',
  'GET /api/v1/supermai/connector/install',
]);

function taskToken(req) {
  return String(req.headers['x-ingest-token'] || '').trim();
}

function deviceOr401(db, req, res) {
  const device = authenticateSupermaiDevice(db, req.headers.authorization);
  if (!device) err(res, 401, 'SUPERMAI_DEVICE_UNAUTHORIZED', '设备连接已失效，请重新配对');
  return device;
}

function baseUrl(options = {}) {
  return productionBaseUrl(options.baseUrl).href.replace(/\/$/, '');
}

function sendDownload(res, filename, content, contentType) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(content);
}

function installer(serverBase) {
  return `#!/bin/zsh
set -eu
BRAINX_DIR="$HOME/Library/Application Support/BrainX"
BUN="/Applications/Sourcing.app/Contents/Resources/bun/bun"
if [ ! -x "$BUN" ]; then
  echo "没有找到 SuperMai/Sourcing，请先安装并打开它。"
  read -k 1 "?按任意键退出…"
  exit 1
fi
mkdir -p "$BRAINX_DIR"
chmod 700 "$BRAINX_DIR"
curl --fail --silent --show-error ${JSON.stringify(`${serverBase}/api/v1/supermai/connector/source`)} -o "$BRAINX_DIR/connector.mjs"
chmod 600 "$BRAINX_DIR/connector.mjs"
"$BUN" "$BRAINX_DIR/connector.mjs" install --server ${JSON.stringify(serverBase)}
echo "BrainX 与 SuperMai 已连接。可以关闭这个窗口。"
read -k 1 "?按任意键退出…"
`;
}

export function supermaiRelayRoutes(db, options = {}) {
  return {
    'POST /api/v1/connections/supermai/pairing-code': (req, res, cid) => {
      json(res, 201, createSupermaiPairCode(db, cid));
    },
    'DELETE /api/v1/connections/supermai/devices/:id': (req, res, cid, q, id) => {
      if (!revokeSupermaiDevice(db, cid, id)) return err(res, 404, 'NOT_FOUND', '设备不存在');
      json(res, 200, { ok: true, device_id: id });
    },
    'POST /api/v1/supermai/pair/claim': async (req, res) => {
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const claimed = claimSupermaiPairCode(db, input);
      if (!claimed) return err(res, 401, 'SUPERMAI_PAIR_CODE_INVALID', '配对码无效、已使用或已过期');
      json(res, 201, claimed);
    },
    'POST /api/v1/supermai/relay/poll': async (req, res) => {
      const device = deviceOr401(db, req, res);
      if (!device) return;
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const output = pollSupermaiRelay(db, device, input);
      if (output.kind === 'sourcing_task') {
        let origin;
        try { origin = baseUrl(options); }
        catch { return err(res, 503, 'BRAINX_BASE_URL_REQUIRED', '服务端未配置正式 HTTPS 地址'); }
        output.ingest = {
          url: `${origin}/api/v1/sourcing/tasks/${encodeURIComponent(output.task_id)}/ingest`,
          token: output.ingest_token,
        };
        delete output.ingest_token;
      }
      json(res, 200, output);
    },
    'POST /api/v1/supermai/relay/report': async (req, res) => {
      const device = deviceOr401(db, req, res);
      if (!device) return;
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const output = reportSupermaiRelay(db, device, input);
      if (!output) return err(res, 404, 'NOT_FOUND', '命令或任务不存在');
      json(res, 200, output);
    },
    'POST /api/v1/sourcing/tasks/:id/ingest': async (req, res, cid, q, id) => {
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const output = ingestSupermaiResults(db, id, taskToken(req), input);
      if (output === null) return err(res, 401, 'INGEST_TOKEN_INVALID', '任务 token 无效或任务已定稿');
      if (output === false) return err(res, 422, 'INGEST_PAYLOAD_INVALID', '候选人批次不符合契约');
      json(res, 200, { code: 0, data: output });
    },
    'POST /api/v1/sourcing/tasks/:id/finish': async (req, res, cid, q, id) => {
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const output = finishSupermaiTask(db, id, taskToken(req), input);
      if (output === null) return err(res, 401, 'INGEST_TOKEN_INVALID', '任务 token 无效');
      if (output === false) return err(res, 409, 'TASK_NOT_RUNNING', '任务不在可定稿状态');
      options.bus?.emit?.({ type: 'supermai_result', task_id: id, status: output.status });
      json(res, 200, { code: 0, data: output });
    },
    'GET /api/v1/supermai/connector/source': (req, res) => {
      sendDownload(res, 'brainx-supermai-connector.mjs', readFileSync(CONNECTOR_PATH),
        'application/javascript; charset=utf-8');
    },
    'GET /api/v1/supermai/connector/install': (req, res) => {
      let origin;
      try { origin = baseUrl(options); }
      catch { return err(res, 503, 'BRAINX_BASE_URL_REQUIRED', '服务端未配置正式 HTTPS 地址'); }
      const archive = zipExecutable('BrainX-SuperMai-连接器.command', installer(origin));
      sendDownload(res, 'BrainX-SuperMai-连接器.zip', archive, 'application/zip');
    },
  };
}
