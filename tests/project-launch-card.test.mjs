/** specs/014：项目群卡片动作 + 群内接单授权。不触网。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { confirmMembership } from '../src/membership.js';
import { buildProjectLaunchCard } from '../src/project-launch.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';
import { createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import { bindIdentity, grantGroupScope } from '../src/agent-gateway/admin.js';
import { authorizePrincipal, hashFeishuAppKey } from '../src/agent-gateway/authorization.js';

// 卡片里的「打开职位工作台」链接需要 https base URL；仓库 .env 会把它设成 127.0.0.1，
// 这里强制覆盖，避免 productionBaseUrl 抛 BRAINX_BASE_URL_INVALID 导致补卡静默不发。
process.env.BRAINX_BASE_URL = 'https://base.yorkteam.cn';
const APP_HASH = hashFeishuAppKey('cli_brainx_014');
const NOW = '2026-09-10T12:00:00.000Z';
const BASE = 'https://base.yorkteam.cn/';
const JOB = {
  project_id: 'P-CARD-1', company: '海马云', role: '资深产品经理',
  city: '上海', hc: 2, pipeline: '待推荐', consultant_name: 'Felix',
};

const descendants = (elements) => elements.flatMap((element) => [
  element,
  ...descendants(element.elements || []),
  ...(element.actions || []),
]);
const buttonsOf = (card) => descendants(card.elements)
  .filter((element) => element.tag === 'button' && element.value?.text);

test('卡片：已接单给三个找人按钮 + 条件输入框，未接单只给接单按钮', () => {
  const accepted = buildProjectLaunchCard(JOB, { publicBaseUrl: BASE, state: 'ACCEPTED' });
  assert.deepEqual(buttonsOf(accepted).map((b) => b.text.content),
    ['OpenMai 找人', 'Reloop 找人', 'SuperMai 找人', '按条件找人']);
  const commands = buttonsOf(accepted).map((b) => b.value.text);
  assert.match(commands[0], /brainx_openmai_search/);
  assert.match(commands[1], /brainx_candidate_shortlist/);
  assert.match(commands[2], /brainx_supermai_scout/);
  assert.match(commands[3], /brainx_openmai_search/);
  for (const index of [0, 2, 3]) {
    assert.ok(commands[index].startsWith('[BRAINTEX_SEARCH_START]'));
    assert.match(commands[index], /正在找人/);
    assert.match(commands[index], /结束本轮/);
  }
  for (const command of commands) {
    assert.ok(command.includes(`项目 ${JOB.project_id}`), command);
    assert.match(command, /不要再?询问|不要再次询问/);
  }
  const form = accepted.elements.find((element) => element.tag === 'form');
  assert.equal(form.name, 'project_search_form');
  const input = form.elements.find((element) => element.tag === 'input');
  assert.equal(input.name, 'criteria');
  assert.equal(input.required, false);
  const submit = form.elements.find((element) => element.tag === 'button');
  assert.equal(submit.action_type, 'form_submit');
  assert.equal(submit.name, 'submit_project_search');
  assert.equal(submit.value.brainx_form, true);
  assert.match(accepted.elements[1].content, /已接单/);

  const pending = buildProjectLaunchCard(JOB, { publicBaseUrl: BASE, state: 'NEW' });
  assert.deepEqual(buttonsOf(pending).map((b) => b.text.content), ['接单']);
  assert.match(buttonsOf(pending)[0].value.text, /brainx_accept_job/);
  assert.match(buttonsOf(pending)[0].value.text, /"confirm": true/);
  assert.equal(descendants(pending.elements).some((element) => element.tag === 'input'), false);
  assert.match(pending.elements[1].content, /尚未接单/);
});

test('卡片：表单指令只读取结构化 criteria 并传给 OpenMai', () => {
  const card = buildProjectLaunchCard(JOB, { publicBaseUrl: BASE, state: 'ACCEPTED' });
  const criteria = buttonsOf(card).at(-1).value.text;
  assert.match(criteria, /BRAINTEX_CARD_FORM/);
  assert.match(criteria, /criteria/);
  assert.match(criteria, /原样作为 brainx_openmai_search/);
  // 未接单卡片必须出现接入提示，避免顾问以为按钮坏了
  assert.match(buildProjectLaunchCard(JOB, { publicBaseUrl: BASE, state: 'NEW' }).elements[1].content,
    /按钮暂无响应|稍候/);
});

function seededDb(allowedPurposes) {
  const db = openDb(':memory:');
  for (const [openId, consultantId] of [['ou_mia', 'mia'], ['ou_felix', 'felix']]) {
    bindIdentity(db, {
      tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
      openId, consultantId,
    }, { actor: 'admin', allowedAdmins: ['admin'], auditKey: 'k'.repeat(40) });
  }
  grantGroupScope(db, {
    tenantId: 'tenant-a', accountId: 'brainx-prod', chatId: 'oc_card',
    allowedPurposes, allowedSenders: ['ou_mia'], projectRefs: ['P-CARD-1'],
  }, { actor: 'admin', allowedAdmins: ['admin'], auditKey: 'k'.repeat(40) });
  return db;
}

const groupPayload = (overrides = {}) => ({
  channel: 'feishu', account_id: 'brainx-prod', requester_sender_id: 'ou_mia',
  chat_type: 'group', chat_id: 'oc_card', purpose: 'job_action',
  tool_name: 'brainx_accept_job', ...overrides,
});

test('群内接单：工具不再限定私聊，群 scope 含 job_action 时放行', () => {
  const registry = createToolRegistry({});
  assert.equal(registry.requiresP2p('brainx_accept_job'), false);
  assert.equal(registry.requiresGroupProject('brainx_accept_job'), true);

  const db = seededDb(['job_review', 'job_action']);
  const allowed = authorizePrincipal(db, groupPayload(), {
    feishuAppKeyHash: APP_HASH, projectRef: 'P-CARD-1', requireProjectScope: true,
  });
  assert.equal(allowed.consultantId, 'mia');

  // 仍然受 sender / 项目范围 / 未登记群约束，放开的是"必须私聊"这一条
  for (const changed of [
    { requester_sender_id: 'ou_felix' }, { chat_id: 'oc_unknown' },
  ]) {
    assert.throws(() => authorizePrincipal(db, { ...groupPayload(), ...changed }, {
      feishuAppKeyHash: APP_HASH, projectRef: 'P-CARD-1', requireProjectScope: true,
    }), /NOT_FOUND_OR_FORBIDDEN/);
  }
  assert.throws(() => authorizePrincipal(db, groupPayload(), {
    feishuAppKeyHash: APP_HASH, projectRef: 'P-OTHER', requireProjectScope: true,
  }), /NOT_FOUND_OR_FORBIDDEN/);
});

test('群内接单：存量群未登记 job_action 时仍拒绝（migration 0049 的必要性）', () => {
  const db = seededDb(['job_review', 'candidate_review']);
  assert.throws(() => authorizePrincipal(db, groupPayload(), {
    feishuAppKeyHash: APP_HASH, projectRef: 'P-CARD-1', requireProjectScope: true,
  }), /NOT_FOUND_OR_FORBIDDEN/);
});

test('migration 0049：存量群 scope 幂等补齐 job_action', () => {
  const db = openDb(':memory:');
  const sql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..',
    'migrations', '0049_group_scope_job_action.sql'), 'utf8');
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id, tenant_id, channel_account_id, chat_id, scope_status,
     allowed_purposes_json, allowed_senders_json, project_refs_json, created_at, updated_at)
    VALUES ('scope-legacy','tenant-a','brainx-prod','oc_legacy','ACTIVE',?,?,?,?,?)`).run(
    JSON.stringify(['job_review', 'candidate_action']), JSON.stringify(['ou_mia']),
    JSON.stringify(['P-CARD-1']), NOW, NOW,
  );
  db.exec(sql);
  assert.deepEqual(JSON.parse(db.prepare(
    'SELECT allowed_purposes_json p FROM agent_group_scopes WHERE group_scope_id=?').get('scope-legacy').p),
  ['job_review', 'candidate_action', 'job_action']);
  db.exec(sql); // 重复执行：不重复追加、不破坏原顺序
  assert.deepEqual(JSON.parse(db.prepare(
    'SELECT allowed_purposes_json p FROM agent_group_scopes WHERE group_scope_id=?').get('scope-legacy').p),
  ['job_review', 'candidate_action', 'job_action']);

  // 已停用的群与非 JSON 脏数据不被动
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id, tenant_id, channel_account_id, chat_id, scope_status,
     allowed_purposes_json, allowed_senders_json, project_refs_json, created_at, updated_at)
    VALUES ('scope-off','tenant-a','brainx-prod','oc_off','REVOKED',?,?,?,?,?),
           ('scope-dirty','tenant-a','brainx-prod','oc_dirty','ACTIVE',?,?,?,?,?)`).run(
    JSON.stringify(['job_review']), JSON.stringify(['ou_mia']), JSON.stringify(['P-CARD-1']), NOW, NOW,
    'not-json', JSON.stringify(['ou_mia']), JSON.stringify(['P-CARD-1']), NOW, NOW,
  );
  db.exec(sql);
  assert.deepEqual(JSON.parse(db.prepare(
    'SELECT allowed_purposes_json p FROM agent_group_scopes WHERE group_scope_id=?').get('scope-off').p),
  ['job_review']);
  assert.equal(db.prepare(
    'SELECT allowed_purposes_json p FROM agent_group_scopes WHERE group_scope_id=?').get('scope-dirty').p,
  'not-json');
});

function acceptDb(withLaunch = true) {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: {
    as_of: now(), jobs: [{ project_id: 'P-ACC', company: '海马云', role: '产品经理', city: '上海',
      pipeline: '待推荐', hc: 2, active_state: 'OPEN', source_url: null, captured_at: now() }],
  } });
  confirmMembership(db, 'felix', 'P-ACC', { relation: 'MY_JOB', idempotency_key: 'acc-membership' });
  if (withLaunch) {
    db.prepare(`INSERT INTO project_launches
      (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,created_at,updated_at)
      VALUES ('launch-acc','felix','P-ACC','acc-key','READY','READY','oc_acc',?,?)`).run(now(), now());
  }
  return db;
}

const acceptIn = (db, sendCardFn) => createActionToolHandlers({
  db, startSearchFn: () => ({ status: 'already_done' }), sendCardFn,
}).brainx_accept_job({ job_id: 'P-ACC', confirm: true },
  { principal: { consultantId: 'felix', purpose: 'job_action' } });

test('接单成功后自动补一张找人卡，卡片不再停在接单按钮', async () => {
  const db = acceptDb();
  const sent = [];
  const out = acceptIn(db, async (input) => { sent.push(input); return { message_id: 'om_acc' }; });
  assert.equal(out.data.state, 'ACCEPTED');
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target, 'oc_acc');
  assert.equal(sent[0].idempotencyKey, 'accepted-card:P-ACC:oc_acc');
  assert.deepEqual(descendants(sent[0].card.elements)
    .filter((element) => element.tag === 'button').map((button) => button.text.content),
    ['OpenMai 找人', 'Reloop 找人', 'SuperMai 找人', '按条件找人', '打开职位工作台']);
  db.close();
});

test('接单补卡是 best-effort：没有项目群或发卡失败都不影响接单结果', async () => {
  const noChat = acceptDb(false);
  let calls = 0;
  const out = acceptIn(noChat, async () => { calls += 1; return { message_id: 'om_x' }; });
  assert.equal(out.data.state, 'ACCEPTED');
  assert.equal(calls, 0);
  noChat.close();

  const db = acceptDb();
  const failing = acceptIn(db, async () => { throw new Error('FEISHU_SEND_FAILED'); });
  assert.equal(failing.data.state, 'ACCEPTED', '发卡失败不得回滚已成功的接单');
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  db.close();
});
