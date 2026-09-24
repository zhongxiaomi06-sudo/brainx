/** 统一身份提供方与找人来源状态 HTTP 边界。 */
import { json } from './server-http.js';
import { authProviderCatalog, connectionStatuses } from './connection-providers.js';

export function connectionRoutes(db, deps = {}) {
  return {
    'GET /api/v1/auth/providers': (req, res) => json(res, 200, authProviderCatalog()),
    'GET /api/v1/connections': async (req, res, cid) => {
      json(res, 200, await connectionStatuses(db, cid, deps));
    },
  };
}
