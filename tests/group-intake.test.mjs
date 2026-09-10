import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { confirmMembership } from '../src/membership.js';
import { bindIdentity, grantGroupScope } from '../src/agent-gateway/admin.js';
import { authorizePrincipal, hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { createProductionToolRegistry } from '../src/agent-gateway/tool-registry.js';
import {
  bindCurrentGroupProject, buildGroupBindingCard, listBotChats, runGroupIntakeSweep,
} from '../src/group-intake.js';

const BASE = 'https://base.yorkteam.cn/';
const HASH = hashFeishuAppKey('cli_group_intake');
const admin = { actor: 'admin', allowedAdmins: ['admin'], auditKey: 'k'.repeat(40) };
const response = (body) => ({ ok: true, json: async () => body });

function dbWithIdentity() {
  const db = openDb(':memory:');
  bindIdentity(db, {
    tenantId: 'tenant-a', accountId: 'mia', feishuAppKeyHash: HASH,
    openId: 'ou_felix', consultantId: 'felix',
  }, admin);
  return db;
}

test('群列表：使用应用 token 翻页并只保留合法群 ID', async () => {
  const urls = [];
  const chats = await listBotChats({ appId: 'cli_a', appSecret: 'secret', fetchImpl: async (url) => {
    urls.push(String(url));
    if (urls.length === 1) return response({ code: 0, tenant_access_token: 'tenant-token' });
    if (urls.length === 2) return response({ code: 0, data: {
      items: [{ chat_id: 'oc_old', name: '旧群' }, { chat_id: 'bad', name: '非法' }],
      has_more: true, page_token: 'next-1',
    } });
    return response({ code: 0, data: {
      items: [{ chat_id: 'oc_new', name: '新群' }], has_more: false,
    } });
  } });
  assert.deepEqual(chats, [{ chat_id: 'oc_old', name: '旧群' }, { chat_id: 'oc_new', name: '新群' }]);
  assert.match(urls[2], /page_token=next-1/);
});

test('新群发现：首轮只建基线，之后仅给未知且未绑定群发一次绑定卡', async () => {
  const db = dbWithIdentity();
  const sent = [];
  const options = {
    tenantId: 'tenant-a', accountId: 'mia', publicBaseUrl: BASE,
    ensureGroup: async () => ({ ok: true }),
    sendCard: async (input) => { sent.push(input); return { message_id: 'om_bind' }; },
  };
  const baseline = await runGroupIntakeSweep(db, {
    ...options, listChats: async () => [{ chat_id: 'oc_old', name: '历史群' }],
  });
  assert.deepEqual(baseline, { baselined: 1, sent: 0, pending: 0 });
  grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'mia', chatId: 'oc_project',
    allowedPurposes: ['job_review'], allowedSenders: ['ou_felix'], projectRefs: [],
  }, admin);
  const second = await runGroupIntakeSweep(db, {
    ...options, listChats: async () => [
      { chat_id: 'oc_old', name: '历史群' },
      { chat_id: 'oc_project', name: '系统项目群' },
      { chat_id: 'oc_new', name: '新群' },
    ],
  });
  assert.equal(second.sent, 1);
  assert.equal(sent[0].target, 'oc_new');
  const form = sent[0].card.elements.find((element) => element.tag === 'form');
  assert.equal(form.elements.find((element) => element.tag === 'input').name, 'job_id');
  assert.equal(form.elements.find((element) => element.tag === 'button').action_type, 'form_submit');
  assert.equal(db.prepare("SELECT status FROM bot_chat_intake WHERE chat_id='oc_old'").get().status, 'BASELINED');
  assert.equal(db.prepare("SELECT status FROM bot_chat_intake WHERE chat_id='oc_project'").get().status, 'BOUND');
  assert.equal(db.prepare("SELECT status FROM bot_chat_intake WHERE chat_id='oc_new'").get().status, 'CARD_SENT');
  const scope = db.prepare("SELECT * FROM agent_group_scopes WHERE chat_id='oc_new'").get();
  assert.deepEqual(JSON.parse(scope.allowed_purposes_json), ['group_binding']);
  assert.deepEqual(JSON.parse(scope.allowed_senders_json), []);
  db.close();
});

test('待绑定群：只放行已绑定顾问的绑定工具，绑定后升级范围并投放项目卡', async () => {
  const db = dbWithIdentity();
  await runGroupIntakeSweep(db, {
    tenantId: 'tenant-a', accountId: 'mia', publicBaseUrl: BASE,
    listChats: async () => [], ensureGroup: async () => {}, sendCard: async () => ({}),
  });
  await runGroupIntakeSweep(db, {
    tenantId: 'tenant-a', accountId: 'mia', publicBaseUrl: BASE,
    listChats: async () => [{ chat_id: 'oc_bind', name: '客户旧群' }],
    ensureGroup: async () => {}, sendCard: async () => ({ message_id: 'om_intake' }),
  });
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const projectId = db.prepare("SELECT project_id FROM job_facts WHERE active_state='OPEN' LIMIT 1").get().project_id;
  confirmMembership(db, 'felix', projectId, {
    relation: 'MY_JOB', idempotency_key: `bind:${projectId}`,
  });
  const payload = {
    channel: 'feishu', account_id: 'mia', requester_sender_id: 'ou_felix',
    chat_type: 'group', chat_id: 'oc_bind', purpose: 'group_binding',
    tool_name: 'brainx_bind_group_project',
  };
  const principal = authorizePrincipal(db, payload, { feishuAppKeyHash: HASH });
  assert.throws(() => authorizePrincipal(db, {
    ...payload, purpose: 'candidate_review', tool_name: 'brainx_candidate_shortlist',
  }, { feishuAppKeyHash: HASH, projectRef: projectId, requireProjectScope: true }),
  /NOT_FOUND_OR_FORBIDDEN/);

  const cards = [];
  const result = await bindCurrentGroupProject(db, principal, projectId, {
    publicBaseUrl: BASE,
    ensureGroup: async (_chat, senders) => { assert.deepEqual(senders, ['ou_felix']); },
    sendCard: async (input) => { cards.push(input); return { message_id: 'om_project' }; },
  });
  assert.deepEqual(result, { job_ref: projectId, bound: true, project_card_sent: true });
  assert.equal(cards[0].target, 'oc_bind');
  assert.match(cards[0].card.header.title.content, /BrainTex 项目/);
  const scope = db.prepare("SELECT * FROM agent_group_scopes WHERE chat_id='oc_bind'").get();
  assert.ok(JSON.parse(scope.allowed_purposes_json).includes('candidate_review'));
  assert.deepEqual(JSON.parse(scope.allowed_senders_json), ['ou_felix']);
  assert.deepEqual(JSON.parse(scope.project_refs_json), [projectId]);
  assert.equal(db.prepare('SELECT chat_id FROM project_launches WHERE project_id=?').get(projectId).chat_id, 'oc_bind');
  assert.equal(db.prepare("SELECT status FROM bot_chat_intake WHERE chat_id='oc_bind'").get().status, 'BOUND');
  db.close();
});

test('绑定工具进入生产目录且不接收 chat_id 参数', () => {
  const db = dbWithIdentity();
  const registry = createProductionToolRegistry({ db });
  assert.equal(registry.has('brainx_bind_group_project'), true);
  assert.deepEqual(Object.keys(registry.schema('brainx_bind_group_project').properties), ['job_id']);
  const card = buildGroupBindingCard({ publicBaseUrl: BASE });
  assert.doesNotMatch(JSON.stringify(card), /"chat_id"/);
  db.close();
});
