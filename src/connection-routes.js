/** 统一身份提供方与找人来源状态 HTTP 边界。 */
import { body, err, json } from './server-http.js';
import { authProviderCatalog, connectionStatuses } from './connection-providers.js';
import { launchSupermaiPlatform } from './supermai-local-connector.js';

export function connectionRoutes(db, deps = {}) {
  return {
    'GET /api/v1/auth/providers': (req, res) => json(res, 200, authProviderCatalog()),
    'GET /api/v1/connections': async (req, res, cid) => {
      json(res, 200, await connectionStatuses(db, cid, deps));
    },
    'POST /api/v1/connections/supermai/start': async (req, res) => {
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const launch = deps.launchSupermaiPlatform || launchSupermaiPlatform;
      const output = await launch(String(input.platform || ''));
      if (output.error_code === 'SUPERMAI_PLATFORM_INVALID') {
        return err(res, 422, output.error_code, '只支持 BOSS、脉脉或猎聘');
      }
      if (!output.ok) return err(res, 503, output.error_code, 'SuperMai 桌面连接器未就绪');
      json(res, 200, output);
    },
  };
}
