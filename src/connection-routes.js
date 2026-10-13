/** 统一身份提供方与找人来源状态 HTTP 边界。 */
import { body, err, json } from './server-http.js';
import { authProviderCatalog, connectionStatuses } from './connection-providers.js';
import { queueSupermaiLogin } from './supermai-relay.js';

export function connectionRoutes(db, deps = {}) {
  return {
    'GET /api/v1/auth/providers': (req, res) => json(res, 200, authProviderCatalog()),
    'GET /api/v1/connections': async (req, res, cid) => {
      json(res, 200, await connectionStatuses(db, cid, deps));
    },
    'POST /api/v1/connections/supermai/start': async (req, res, cid) => {
      const input = await body(req);
      if (!input) return err(res, 400, 'BAD_JSON', '请求体不是合法 JSON');
      const launch = deps.launchSupermaiPlatform
        ? (platform) => deps.launchSupermaiPlatform(platform)
        : (platform) => queueSupermaiLogin(db, cid, platform);
      const output = await launch(String(input.platform || ''));
      if (!output) {
        return err(res, 422, 'SUPERMAI_PLATFORM_INVALID', '只支持 BOSS、脉脉或猎聘');
      }
      if (output.error_code) return err(res, 503, output.error_code, 'SuperMai 桌面连接器未在线');
      json(res, deps.launchSupermaiPlatform ? 200 : 202, {
        ok: true, ...output, user_action: 'COMPLETE_OFFICIAL_LOGIN',
      });
    },
  };
}
