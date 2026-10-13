/** BrainX 身份提供方与找人来源的统一只读状态。 */
import { tokenStatus } from './feishu.js';
import { oauthConfigured } from './oauth.js';
import { talentHealth } from './talent.js';
import { ttcOpenmaiAuthStatus } from './ttcsdk/auth.js';

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

function supermaiConnection(db, consultantId) {
  const shared = openmaiConnection(db, consultantId);
  return {
    ...shared,
    provider: 'supermai',
    error_code: shared.error_code?.replace('OPENMAI_', 'SUPERMAI_') || null,
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
  readReloopHealth = talentHealth,
} = {}) {
  const [reloop] = await Promise.allSettled([readReloopHealth()]);
  return {
    schema_version: CONNECTION_SCHEMA_VERSION,
    identity_provider: 'feishu',
    items: [
      feishuConnection(db, consultantId),
      openmaiConnection(db, consultantId),
      supermaiConnection(db, consultantId),
      reloopConnection(reloop.status === 'fulfilled' ? reloop.value : null),
    ],
  };
}
