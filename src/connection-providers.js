/** BrainX 身份提供方与找人来源的统一只读状态。 */
import { tokenStatus } from './feishu.js';
import { oauthConfigured } from './oauth.js';
import { talentHealth } from './talent.js';
import { ttcOpenmaiAuthStatus } from './ttcsdk/auth.js';
import { supermaiDeviceStatus } from './supermai-relay.js';

export const CONNECTION_SCHEMA_VERSION = 'brainx-connections-v1';

const action = (kind, target = null) => ({ kind, target });
const checkedAt = () => new Date().toISOString();

export function authProviderCatalog() {
  return {
    schema_version: CONNECTION_SCHEMA_VERSION,
    providers: [{
      provider: 'feishu',
      role: 'primary_identity',
      flow: 'authorization_code_system_browser',
      configured: oauthConfigured(),
      start_path: '/api/v1/oauth/authorize',
    }],
  };
}

function feishuConnection(db, consultantId) {
  const status = tokenStatus(db, consultantId);
  const connected = status.authorized && !status.needs_reauth;
  return {
    provider: 'feishu', kind: 'identity', managed_by: 'user',
    state: connected ? 'connected' : 'action_required',
    capabilities: ['identity.login', 'feishu.user_api'],
    needs_user_action: !connected,
    action: connected ? null : action('open_browser', '/api/v1/oauth/authorize'),
    last_checked_at: status.updated_at || checkedAt(),
    error_code: status.needs_reauth ? 'FEISHU_REAUTH_REQUIRED'
      : status.authorized ? null : 'FEISHU_AUTH_REQUIRED',
  };
}

function openmaiConnection(db, consultantId) {
  const status = ttcOpenmaiAuthStatus(db, consultantId);
  const connected = status.connected === true;
  return {
    provider: 'openmai', kind: 'sourcing',
    managed_by: status.credential_mode === 'shared' ? 'organization' : 'user',
    state: connected ? 'connected' : 'action_required',
    capabilities: ['candidate.search'], needs_user_action: !connected,
    action: connected ? null : action('contact_admin'),
    last_checked_at: checkedAt(),
    error_code: status.needs_reauth ? 'OPENMAI_REAUTH_REQUIRED'
      : connected ? null : 'OPENMAI_GRANT_REQUIRED',
  };
}

function supermaiConnection(status) {
  const active = status?.active || status || {};
  const platforms = active.platforms || {};
  const connected = (active.desktop_available === true || active.available === true)
    && Object.values(platforms).some((item) => item.logged_in === true);
  const available = active.desktop_available === true || active.available === true;
  const registered = status?.registered ?? available;
  const online = status?.online ?? available;
  return {
    provider: 'supermai', kind: 'sourcing', managed_by: 'device',
    state: connected ? 'connected' : registered ? 'action_required' : 'unavailable',
    capabilities: ['candidate.search'], needs_user_action: !connected,
    action: connected ? null : action(registered ? 'open_desktop' : 'install_connector',
      registered ? 'brainx://connections/supermai' : '/api/v1/supermai/connector/install'),
    last_checked_at: active.last_seen_at || checkedAt(),
    error_code: connected ? null
      : available ? 'SUPERMAI_PLATFORM_LOGIN_REQUIRED'
        : registered && !online ? 'SUPERMAI_DEVICE_OFFLINE'
          : registered ? 'SUPERMAI_DESKTOP_UNAVAILABLE'
            : (status?.error_code || 'SUPERMAI_PAIRING_REQUIRED'),
    details: {
      desktop_available: available,
      desktop_busy: active.desktop_busy === true || active.busy === true,
      version: active.version || null,
      platforms,
      registered,
      online,
      devices: Array.isArray(status?.devices) ? status.devices.map((device) => ({
        device_id: device.device_id, name: device.name, online: device.online,
        last_seen_at: device.last_seen_at,
      })) : [],
    },
  };
}

function reloopConnection(status) {
  const connected = status?.ready === true && status?.backend === 'mysql';
  return {
    provider: 'reloop', kind: 'sourcing', managed_by: 'organization',
    state: connected ? 'organization_managed' : 'unavailable',
    capabilities: ['candidate.shortlist'], needs_user_action: false, action: null,
    last_checked_at: checkedAt(),
    error_code: connected ? null : (status?.error_code || 'RELOOP_UNAVAILABLE'),
    details: {
      backend: status?.backend || null,
      schema: status?.schema || null,
    },
  };
}

export async function connectionStatuses(db, consultantId, {
  readSupermaiStatus = (database, cid) => supermaiDeviceStatus(database, cid),
  readReloopHealth = talentHealth,
} = {}) {
  const [supermai, reloop] = await Promise.allSettled([
    readSupermaiStatus(db, consultantId), readReloopHealth(),
  ]);
  return {
    schema_version: CONNECTION_SCHEMA_VERSION,
    identity_provider: 'feishu',
    items: [
      feishuConnection(db, consultantId),
      openmaiConnection(db, consultantId),
      supermaiConnection(supermai.status === 'fulfilled' ? supermai.value : null),
      reloopConnection(reloop.status === 'fulfilled' ? reloop.value : null),
    ],
  };
}
