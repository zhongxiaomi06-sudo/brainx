/** specs/015：机器人进旧群自动发卡 + 绑定。不触网。 */
process.env.BRAINX_BASE_URL = 'https://base.yorkteam.cn';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { confirmMembership } from '../src/membership.js';
import { setChatEnabled, registerChatContext } from '../src/gateway/chat-contexts.js';
import { bindIdentity, grantGroupScope } from '../src/agent-gateway/admin.js';
import { authorizePrincipal, hashFeishuAppKey } from '../src/agent-gateway/authorization.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';
import { createToolRegistry } from '../src/agent-gateway/tool-registry.js';
import {
  runGroupIntakeOnce, buildBindCard, buildGuidanceCard, bindGroupToProject, listBindableJobs,
} from '../src/group-intake.js';

const APP_HASH = hashFeishuAppKey('cli_brainx_015');
const ADMIN = { actor: 'admin', allowedAdmins: ['admin'], auditKey: 'k'.repeat(40) };
const PID = 'P-INTAKE-1';

function readyDb() {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: {
    as_of: now(), jobs: [{ project_id: PID, company: '海马云', role: '产品经理', city: '上海',
      pipeline: '待推荐', hc: 2, active_state: 'OPEN', source_url: null, captured_at: now() }],
  } });
  confirmMembership(db, 'felix', PID, { relation: 'MY_JOB', idempotency_key: 'intake-mbr' });
  const openId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  bindIdentity(db, { tenantId: 'tenant-a', accountId: 'brainx-prod', feishuAppKeyHash: APP_HASH,
    openId, consultantId: 'felix' }, ADMIN);
  return db;
}

const fakeChats = (ids) => ids.map((id, i) => ({ chat_id: id, name: `群${i}`, chat_mode: 'group' }));

test('首轮只做基线：全部记 SEEN，不发卡、不登记群范围', async () => {
  const db = readyDb();
  const sent = [];
  const out = await runGroupIntakeOnce(db, {
    listChats: async () => fakeChats(['oc_a', 'oc_b', 'oc_c']),
    sendCard: async (input) => { sent.push(input); return { message_id: 'om' }; },
    ensureOpenClawGroup: async () => {},
  });
  assert.equal(out.baseline, true);
  assert.equal(sent.length, 0, '基线轮不得发卡');
  const rows = db.prepare('SELECT chat_id, status FROM bot_chat_intake ORDER BY chat_id').all()
    .map((r) => ({ chat_id: r.chat_id, status: r.status }));
  assert.deepEqual(rows, [
    { chat_id: 'oc_a', status: 'SEEN' }, { chat_id: 'oc_b', status: 'SEEN' }, { chat_id: 'oc_c', status: 'SEEN' },
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM agent_group_scopes').get().n, 0, '基线不得登记群范围');
  db.close();
});

test('新群：登记 chat_context + openclaw 准入 + 发绑定卡 + 标 CARD_SENT', async () => {
  const db = readyDb();
  // 先做一轮基线（让 oc_old 进表），再发现 oc_new
  let call = 0;
  const listChats = async () => { call += 1; return call === 1 ? fakeChats(['oc_old']) : fakeChats(['oc_old', 'oc_new']); };
  const allows = [];
  const sent = [];
  await runGroupIntakeOnce(db, { listChats, sendCard: async (i) => { sent.push(i); return { message_id: 'om' }; },
    ensureOpenClawGroup: async (chatId, senders) => { allows.push([chatId, senders]); } });
  assert.equal(sent.length, 0);
  await runGroupIntakeOnce(db, { listChats, sendCard: async (i) => { sent.push(i); return { message_id: 'om_new' }; },
    ensureOpenClawGroup: async (chatId, senders) => { allows.push([chatId, senders]); } });
  assert.equal(sent.length, 1, '只有新群发卡');
  assert.equal(sent[0].target, 'oc_new');
  assert.match(sent[0].idempotencyKey, /^intake-bind-card:oc_new$/);
  const row = db.prepare('SELECT status, chat_name FROM bot_chat_intake WHERE chat_id=?').get('oc_new');
  assert.equal(row.status, 'CARD_SENT');
  assert.equal(row.chat_name, '群1');
  assert.deepEqual(allows.at(-1), ['oc_new', []], '准入 senders 为空');
  assert.equal(db.prepare('SELECT enabled FROM chat_contexts WHERE chat_id=?').get('oc_new').enabled, 1);
  db.close();
});

test('已禁用的死群：标 SKIPPED 不发卡', async () => {
  const db = readyDb();
  registerChatContext(db, { chat_id: 'oc_dead' });
  setChatEnabled(db, 'oc_dead', false);
  const sent = [];
  await runGroupIntakeOnce(db, {
    listChats: async () => fakeChats(['oc_dead']),
    sendCard: async (i) => { sent.push(i); return { message_id: 'om' }; },
    ensureOpenClawGroup: async () => {},
  });
  assert.equal(sent.length, 0);
  assert.equal(db.prepare('SELECT status FROM bot_chat_intake WHERE chat_id=?').get('oc_dead').status, 'SKIPPED');
  db.close();
});

function intakeBindingPayload(overrides = {}) {
  return {
    channel: 'feishu', account_id: 'brainx-prod', requester_sender_id: 'ou_felix',
    chat_type: 'group', chat_id: 'oc_new', purpose: 'group_binding',
    tool_name: 'brainx_bind_group_project', ...overrides,
  };
}

test('授权：未绑定群只放行 bind 工具；未接管/已绑定的群拒绝', () => {
  const db = readyDb();
  db.prepare('SELECT open_id FROM consultants WHERE consultant_id=?').get('felix'); // warm
  const openId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  db.prepare('UPDATE feishu_identity_bindings SET open_id=? WHERE consultant_id=?').run('ou_felix', 'felix');
  db.prepare('INSERT INTO bot_chat_intake (chat_id, chat_name, status, first_seen_at, updated_at) VALUES (?,?,?,?,?)')
    .run('oc_new', '群', 'CARD_SENT', now(), now());

  const ok = authorizePrincipal(db, intakeBindingPayload(), { feishuAppKeyHash: APP_HASH, allowIntakeBinding: true });
  assert.equal(ok.consultantId, 'felix');

  // 未接管的群：明确报 GROUP_NOT_INTAKED（specs/017，此前是裸 NOT_FOUND_OR_FORBIDDEN）
  assert.throws(() => authorizePrincipal(db, intakeBindingPayload({ chat_id: 'oc_unknown' }),
    { feishuAppKeyHash: APP_HASH, allowIntakeBinding: true }), /GROUP_NOT_INTAKED/);
  // 已绑定的群拒绝（不能再 bind）
  db.prepare('UPDATE bot_chat_intake SET status=? WHERE chat_id=?').run('BOUND', 'oc_new');
  assert.throws(() => authorizePrincipal(db, intakeBindingPayload(),
    { feishuAppKeyHash: APP_HASH, allowIntakeBinding: true }), /GROUP_ALREADY_BOUND/);
  // 普通工具（无 allowIntakeBinding）在未绑定群拒绝
  db.prepare('UPDATE bot_chat_intake SET status=? WHERE chat_id=?').run('CARD_SENT', 'oc_new');
  assert.throws(() => authorizePrincipal(db, intakeBindingPayload({
    tool_name: 'brainx_candidate_shortlist', purpose: 'candidate_review',
  }), { feishuAppKeyHash: APP_HASH }), /NOT_FOUND_OR_FORBIDDEN/);
  db.close();
});

test('授权（specs/017）：私聊里调 bind 直接 GROUP_REQUIRED，不放行到 handler', () => {
  const db = readyDb();
  db.prepare('UPDATE feishu_identity_bindings SET open_id=? WHERE consultant_id=?').run('ou_felix', 'felix');
  // 私聊：chat_id 就是顾问 open_id（intake 表里永远不会有）
  assert.throws(() => authorizePrincipal(db, intakeBindingPayload({
    chat_type: 'p2p', chat_id: 'ou_felix',
  }), { feishuAppKeyHash: APP_HASH, allowIntakeBinding: true }), /GROUP_REQUIRED/);
  db.close();
});

test('bind 工具：不传 job_id 返回顾问可绑职位清单', async () => {
  const db = readyDb();
  const openId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  const sent = [];
  const h = createActionToolHandlers({ db, sendCardFn: async (i) => { sent.push(i); return { message_id: 'om' }; } });
  const out = await h.brainx_bind_group_project({ confirm: false },
    { principal: { consultantId: 'felix', chatId: 'oc_new', chatType: 'group', purpose: 'group_binding' } });
  assert.ok(Array.isArray(out.data.bindable_jobs));
  assert.equal(out.data.bindable_jobs.length, 1);
  assert.equal(out.data.bindable_jobs[0].project_id, PID);
  assert.equal(sent.length, 0, 'list 模式不发卡');
  db.close();
});

test('bind 工具：传 job_id+confirm 激活群范围、回填 chat_id、发找人卡+指引卡、标 BOUND', async () => {
  const db = readyDb();
  const openId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  db.prepare('INSERT INTO bot_chat_intake (chat_id, chat_name, status, first_seen_at, updated_at) VALUES (?,?,?,?,?)')
    .run('oc_new', '海马云项目群', 'CARD_SENT', now(), now());
  const sent = [];
  const h = createActionToolHandlers({ db, sendCardFn: async (i) => { sent.push(i); return { message_id: 'om' }; } });
  const out = await h.brainx_bind_group_project({ job_id: PID, confirm: true },
    { principal: { consultantId: 'felix', chatId: 'oc_new', chatType: 'group', purpose: 'group_binding' } });
  assert.equal(out.data.bound, true);
  assert.equal(out.data.project_id, PID);
  assert.equal(out.data.chat_id, 'oc_new');

  const scope = db.prepare('SELECT scope_status, allowed_purposes_json, project_refs_json FROM agent_group_scopes WHERE chat_id=?').get('oc_new');
  assert.equal(scope.scope_status, 'ACTIVE');
  assert.ok(JSON.parse(scope.allowed_purposes_json).includes('job_action'));
  assert.deepEqual(JSON.parse(scope.project_refs_json), [PID]);
  assert.equal(db.prepare('SELECT chat_id FROM job_facts WHERE project_id=?').get(PID).chat_id, 'oc_new');
  assert.equal(db.prepare('SELECT status, project_id FROM bot_chat_intake WHERE chat_id=?').get('oc_new').status, 'BOUND');

  await new Promise((r) => { setTimeout(r, 20); });
  assert.equal(sent.length, 2, '群里发找人卡 + 顾问私聊发指引卡');
  assert.equal(sent[0].target, 'oc_new');
  assert.equal(sent[1].target, openId, '指引卡发到顾问私聊');
  assert.match(sent[1].card.elements.find((e) => e.tag === 'markdown').content, /已把群/);
  db.close();
});

test('bind 工具：重复绑定已 BOUND 的群报 GROUP_ALREADY_BOUND', async () => {
  const db = readyDb();
  db.prepare('INSERT INTO bot_chat_intake (chat_id, chat_name, status, first_seen_at, updated_at) VALUES (?,?,?,?,?)')
    .run('oc_new', '群', 'BOUND', now(), now());
  const h = createActionToolHandlers({ db, sendCardFn: async () => ({ message_id: 'om' }) });
  await assert.rejects(() => h.brainx_bind_group_project({ job_id: PID, confirm: true },
    { principal: { consultantId: 'felix', chatId: 'oc_new', chatType: 'group', purpose: 'group_binding' } }),
    /GROUP_ALREADY_BOUND/);
  db.close();
});

test('卡片：绑定卡有「绑定我的职位」按钮；指引卡含如何拉群与不要拉太多群', () => {
  const bind = buildBindCard({ chatName: '客户群', publicBaseUrl: 'https://base.yorkteam.cn' });
  const bindButtons = bind.elements.flatMap((e) => e.actions || []).map((a) => a.text?.content).filter(Boolean);
  assert.deepEqual(bindButtons, ['绑定我的职位', '打开工作台']);
  assert.match(bind.elements.find((e) => e.tag === 'markdown').content, /还没绑定职位/);

  const guidance = buildGuidanceCard({ chatName: '客户群', job: { company: '海马云', role: '产品经理' },
    consultantName: 'Felix', publicBaseUrl: 'https://base.yorkteam.cn' });
  const md = guidance.elements.filter((e) => e.tag === 'markdown').map((e) => e.content).join('\n');
  assert.match(md, /如何拉群/);
  assert.match(md, /不要拉太多群/);
  assert.match(md, /海马云·产品经理/);
});

test('注册表：brainx_bind_group_project 标记 groupIntakeBinding，非 p2p、不要求项目范围', () => {
  const registry = createToolRegistry({});
  assert.equal(registry.requiresIntakeBinding('brainx_bind_group_project'), true);
  assert.equal(registry.requiresP2p('brainx_bind_group_project'), false);
  assert.equal(registry.requiresGroupProject('brainx_bind_group_project'), false);
});
