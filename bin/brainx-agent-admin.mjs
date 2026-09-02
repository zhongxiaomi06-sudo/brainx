#!/usr/bin/env node
import '../src/env.js';
import { openDb } from '../src/db.js';
import { hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { bindIdentity, revokeIdentity, grantGroupScope, revokeGroupScope } from '../src/agent-gateway/admin.js';

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

const command = process.argv[2];
const input = flags(process.argv.slice(3));
const admin = {
  actor: process.env.BRAINX_AGENT_ADMIN_ID,
  allowedAdmins: list(process.env.BRAINX_AGENT_ADMIN_ALLOWLIST),
  auditKey: process.env.BRAINX_AGENT_AUDIT_KEY,
};
const db = openDb();
let result;

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
} else {
  throw new Error('命令：bind-identity | revoke-identity | grant-group | revoke-group');
}

console.log(JSON.stringify(result));
