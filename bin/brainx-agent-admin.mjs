#!/usr/bin/env node
import '../src/env.js';
import { openDb } from '../src/db.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import {
  bindIdentity, revokeIdentity, grantGroupScope, revokeGroupScope,
  bindRosterIdentities, getRecruitingReadiness,
} from '../src/agent-gateway/admin.js';
import { grantSharedTtcCredential, revokeSharedTtcCredential } from '../src/ttcsdk/auth.js';
import { launchProject } from '../src/project-launch.js';

function flags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith('--') || argv[index + 1] === undefined) throw new Error('参数必须使用 --name value');
    result[key.slice(2)] = argv[index + 1];
  }
  return result;
}

function list(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function appHash(accountId) {
  const appKeys = JSON.parse(process.env.BRAINX_AGENT_FEISHU_APP_KEYS_JSON || '{}');
  if (!appKeys[accountId]) throw new Error('该 account 未在 BRAINX_AGENT_FEISHU_APP_KEYS_JSON 配置');
  return hashFeishuAppKey(appKeys[accountId]);
}

function allowedOpenIds() {
  return Object.entries(process.env)
    .filter(([key]) => /^BRAINX_FEISHU_ALLOWED_OPEN_ID_\d+$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value).filter(Boolean);
}

const command = process.argv[2];
const input = flags(process.argv.slice(3));
const admin = {
  actor: process.env.BRAINX_AGENT_ADMIN_ID,
  allowedAdmins: list(process.env.BRAINX_AGENT_ADMIN_ALLOWLIST),
  auditKey: process.env.BRAINX_AGENT_AUDIT_KEY,
};
const db = openDb();
let result;

function requireAdmin() {
  if (!admin.actor || !admin.allowedAdmins.includes(admin.actor)) throw new Error('ADMIN_NOT_ALLOWED');
}

if (command === 'bind-identity') {
  result = bindIdentity(db, {
    tenantId: input.tenant, accountId: input.account, openId: input['open-id'],
    consultantId: input.consultant, employeeRef: input['employee-ref'],
    feishuAppKeyHash: appHash(input.account),
  }, admin);
} else if (command === 'revoke-identity') {
  result = revokeIdentity(db, { accountId: input.account, openId: input['open-id'] }, admin);
} else if (command === 'grant-group') {
  result = grantGroupScope(db, {
    tenantId: input.tenant, accountId: input.account, chatId: input['chat-id'],
    allowedPurposes: list(input.purposes), allowedSenders: list(input.senders),
    projectRefs: list(input.projects),
  }, admin);
} else if (command === 'revoke-group') {
  result = revokeGroupScope(db, { accountId: input.account, chatId: input['chat-id'] }, admin);
} else if (command === 'readiness') {
  result = getRecruitingReadiness(db, {
    accountId: input.account, feishuAppKeyHash: appHash(input.account),
    allowedOpenIds: allowedOpenIds(),
  }, admin);
} else if (command === 'bind-roster') {
  result = bindRosterIdentities(db, {
    tenantId: input.tenant, accountId: input.account,
    feishuAppKeyHash: appHash(input.account),
    consultantIds: list(input.consultants), confirm: input.confirm === 'true',
  }, admin);
} else if (command === 'grant-ttc-openmai') {
  requireAdmin();
  if (input.confirm !== 'true') throw new Error('CONFIRM_REQUIRED');
  result = grantSharedTtcCredential(db, {
    sourceConsultantId: input.source, granteeConsultantId: input.grantee,
    purpose: 'OPENMAI', grantedBy: admin.actor, reason: input.reason,
  });
} else if (command === 'revoke-ttc-openmai') {
  requireAdmin();
  if (input.confirm !== 'true') throw new Error('CONFIRM_REQUIRED');
  result = { revoked: revokeSharedTtcCredential(db, input.grantee, 'OPENMAI') };
} else if (command === 'launch-redeliver') {
  // specs/013：群已建但卡片没发出来时重放（跳过建群 → 补发卡片 → 重试准入），幂等
  try {
    result = await launchProject(db, input.consultant, input.project, {
      idempotency_key: input['idempotency-key'] || `redeliver:${input.consultant}:${input.project}`,
      // specs/014：force 重发一张卡片（卡片结构或承接状态变了时用），默认幂等跳过
      force: input.force === 'true',
    }, {});
  } catch (error) {
    result = { ok: false, code: error.code || 'PROJECT_LAUNCH_FAILED',
      message: String(error.message).slice(0, 300) };
  }
} else {
  throw new Error('命令：readiness | bind-roster | bind-identity | revoke-identity | grant-group | revoke-group | grant-ttc-openmai | revoke-ttc-openmai');
}

console.log(JSON.stringify(result));
