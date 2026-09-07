import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { confirmMembership } from '../src/membership.js';
import { launchProject, launchRecruitingWorkflow, ProjectLaunchError } from '../src/project-launch.js';
import { listProjects } from '../src/projects.js';

const PID = 'P-LAUNCH-1';

function readyDb({ withBinding = true } = {}) {
  const db = openDb(':memory:');
  runSync(db, { source: 'test', consultant_id: 'felix', payload: {
    as_of: now(), jobs: [{ project_id: PID, company: '海马云', role: '产品经理', city: '上海',
      pipeline: '待推荐', hc: 2, active_state: 'OPEN', source_url: null, captured_at: now() }],
  } });
  confirmMembership(db, 'felix', PID, { relation: 'MY_JOB', idempotency_key: 'join-launch' });
  if (withBinding) {
    const openId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
    db.prepare(`INSERT INTO feishu_identity_bindings
      (binding_id, tenant_id, channel_account_id, feishu_app_key_hash, open_id, consultant_id,
       binding_status, verified_at, verified_by, created_at, updated_at)
      VALUES ('binding-launch','tenant-a','brainx-prod',?,?,'felix','ACTIVE',?,'system',?,?)`).run(
      'a'.repeat(64), openId, now(), now(), now(),
    );
  }
  return db;
}

test('项目启动：建群、投放职位、绑定项目并激活群 Agent 范围', async () => {
  const db = readyDb();
  const calls = [];
  const deps = {
    appConfigured: true,
    publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async (input) => { calls.push(['create', input]); return { chat_id: 'oc_launch', name: input.name }; },
    ensureOpenClawGroupAllowed: async (chatId, senders) => { calls.push(['allow', chatId, senders]); },
    sendInteractiveCard: async (input) => { calls.push(['send', input]); return { message_id: 'om_job' }; },
  };
  const result = await launchProject(db, 'felix', PID, { idempotency_key: 'launch-click-1' }, deps);
  assert.equal(result.launch.status, 'READY');
  assert.equal(result.launch.chat_id, 'oc_launch');
  assert.equal(calls[0][1].ownerOpenId.startsWith('ou_'), true);
  assert.deepEqual(calls[0][1].memberOpenIds, [calls[0][1].ownerOpenId]);
  assert.deepEqual(calls[1], ['allow', 'oc_launch', [calls[0][1].ownerOpenId]]);
  assert.equal(calls[2][1].target, 'oc_launch');
  assert.equal(db.prepare('SELECT chat_id FROM job_facts WHERE project_id=?').get(PID).chat_id, 'oc_launch');
  assert.equal(db.prepare('SELECT enabled FROM chat_contexts WHERE chat_id=?').get('oc_launch').enabled, 1);
  const scope = db.prepare('SELECT * FROM agent_group_scopes WHERE chat_id=?').get('oc_launch');
  assert.deepEqual(JSON.parse(scope.project_refs_json), [PID]);
  assert.ok(JSON.parse(scope.allowed_purposes_json).includes('candidate_action'));
  assert.equal(JSON.parse(scope.allowed_senders_json).length, 1);

  const duplicate = await launchProject(db, 'felix', PID, { idempotency_key: 'another-click' }, deps);
  assert.equal(duplicate.already, true);
  assert.equal(calls.length, 3, '重复启动不得再次改白名单、建群或发卡');
  db.close();
});

test('项目启动：同职位已绑定协作者一起入群并可在群内使用候选工作流', async () => {
  const db = readyDb();
  confirmMembership(db, 'mia', PID, { relation: 'TEAM_SHARED', idempotency_key: 'share-launch' });
  const miaOpenId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='mia'").get().open_id;
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('binding-mia','tenant-a','brainx-prod',?,?, 'mia','ACTIVE',?,'system',?,?)`)
    .run('a'.repeat(64), miaOpenId, now(), now(), now());
  const calls = [];
  const dependencies = {
    appConfigured: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async (input) => { calls.push(input); return { chat_id: 'oc_team', name: input.name }; },
    ensureOpenClawGroupAllowed: async () => {},
    sendInteractiveCard: async () => ({ message_id: 'om_team' }),
  };
  await launchProject(db, 'felix', PID, { idempotency_key: 'team-launch' }, dependencies);
  const ownerOpenId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='felix'").get().open_id;
  assert.deepEqual(new Set(calls[0].memberOpenIds), new Set([ownerOpenId, miaOpenId]));
  const scope = db.prepare("SELECT allowed_senders_json FROM agent_group_scopes WHERE chat_id='oc_team'").get();
  assert.deepEqual(new Set(JSON.parse(scope.allowed_senders_json)), new Set([ownerOpenId, miaOpenId]));
  const shared = await launchProject(db, 'mia', PID, { idempotency_key: 'mia-team-launch' }, dependencies);
  assert.equal(shared.already, true);
  assert.equal(shared.launch.consultant_id, 'felix');
  assert.equal(calls.length, 1, '第二位协作者不得重复建群');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM project_launches WHERE project_id=?')
    .get(PID).count, 1);
  assert.equal(listProjects(db, 'mia', { projectId: PID })[0].launch.chat_id, 'oc_team');
  db.close();
});

test('寻访启动：协作者复用职位共享搜索，不要求自己的 TTC 且不重复扣费', async () => {
  const db = readyDb();
  confirmMembership(db, 'mia', PID, { relation: 'TEAM_SHARED', idempotency_key: 'share-search' });
  const miaOpenId = db.prepare("SELECT open_id FROM consultants WHERE consultant_id='mia'").get().open_id;
  db.prepare(`INSERT INTO feishu_identity_bindings
    (binding_id,tenant_id,channel_account_id,feishu_app_key_hash,open_id,consultant_id,
     binding_status,verified_at,verified_by,created_at,updated_at)
    VALUES ('binding-mia-shared','tenant-a','brainx-prod',?,?,'mia','ACTIVE',?,'system',?,?)`)
    .run('a'.repeat(64), miaOpenId, now(), now(), now());
  const dependencies = {
    appConfigured: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async () => ({ chat_id: 'oc_shared_search', name: '共享项目群' }),
    ensureOpenClawGroupAllowed: async () => {},
    sendInteractiveCard: async () => ({ message_id: 'om_shared_search' }),
  };
  await launchProject(db, 'felix', PID, { idempotency_key: 'owner-launch' }, dependencies);
  db.prepare(`UPDATE project_launches SET search_status='RUNNING',search_task_id='task-owner'
    WHERE project_id=?`).run(PID);
  let searchCalls = 0;
  const out = await launchRecruitingWorkflow(db, null, 'mia', PID, {
    confirm: true, idempotency_key: 'collaborator-launch',
  }, { ...dependencies, ttcConnected: false, startOpenmaiTask: () => { searchCalls++; } });
  assert.deepEqual(out.search, { status: 'running', task_id: 'task-owner', shared: true });
  assert.equal(searchCalls, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM current_engagement
    WHERE consultant_id='mia' AND project_id=?`).get(PID).count, 0);
  db.close();
});

test('项目启动：数据库阻止同一职位写入第二个项目群记录', () => {
  const db = readyDb();
  const at = now();
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,created_at,updated_at)
    VALUES ('launch-one','felix',?,'one','CREATING_CHAT','CREATE_CHAT',?,?)`).run(PID, at, at);
  assert.throws(() => db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,created_at,updated_at)
    VALUES ('launch-two','mia',?,'two','CREATING_CHAT','CREATE_CHAT',?,?)`).run(PID, at, at),
  /PROJECT_LAUNCH_ALREADY_EXISTS/);
  db.close();
});

test('项目启动：群已创建但投放失败时重试复用原群', async () => {
  const db = readyDb();
  let creates = 0;
  let sends = 0;
  const deps = {
    appConfigured: true,
    publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async () => { creates += 1; return { chat_id: 'oc_retry', name: '重试群' }; },
    ensureOpenClawGroupAllowed: async () => {},
    sendInteractiveCard: async () => {
      sends += 1;
      if (sends === 1) throw new Error('temporary');
      return { message_id: 'om_retry' };
    },
  };
  await assert.rejects(
    launchProject(db, 'felix', PID, { idempotency_key: 'retry-1' }, deps),
    (error) => error instanceof ProjectLaunchError && error.status === 502,
  );
  assert.equal(db.prepare('SELECT status FROM project_launches').get().status, 'FAILED');
  let retried;
  try {
    retried = await launchProject(db, 'felix', PID, { idempotency_key: 'retry-2' }, deps);
  } catch (error) {
    assert.fail(`重试失败：${JSON.stringify(db.prepare('SELECT * FROM project_launches').get())} / ${error.message}`);
  }
  assert.equal(retried.launch.status, 'READY');
  assert.equal(creates, 1);
  assert.equal(sends, 2);
  db.close();
});

test('项目启动：OpenClaw 群准入失败时不发职位卡，重试复用原群并补齐准入', async () => {
  const db = readyDb();
  let creates = 0;
  let allows = 0;
  let sends = 0;
  const deps = {
    appConfigured: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async () => { creates++; return { chat_id: 'oc_allow_retry', name: '准入重试群' }; },
    ensureOpenClawGroupAllowed: async () => {
      allows++;
      if (allows === 1) throw Object.assign(new Error('hidden output'), { code: 'OPENCLAW_GROUP_ALLOWLIST_FAILED' });
    },
    sendInteractiveCard: async () => { sends++; return { message_id: 'om_allowed' }; },
  };
  await assert.rejects(launchProject(db, 'felix', PID, { idempotency_key: 'allow-1' }, deps),
    (error) => error.code === 'OPENCLAW_GROUP_ALLOWLIST_FAILED');
  assert.equal(creates, 1);
  assert.equal(sends, 0);
  assert.equal(db.prepare('SELECT chat_id FROM project_launches').get().chat_id, 'oc_allow_retry');
  const retried = await launchProject(db, 'felix', PID, { idempotency_key: 'allow-2' }, deps);
  assert.equal(retried.launch.status, 'READY');
  assert.equal(creates, 1);
  assert.equal(allows, 2);
  assert.equal(sends, 1);
  db.close();
});

test('项目启动：Agent 身份未绑定时在外部写入前阻断', async () => {
  const db = readyDb({ withBinding: false });
  let externalCalls = 0;
  await assert.rejects(
    launchProject(db, 'felix', PID, { idempotency_key: 'blocked' }, {
      appConfigured: true,
      createProjectChat: async () => { externalCalls += 1; },
    }),
    (error) => error.code === 'AGENT_IDENTITY_BINDING_REQUIRED' && error.status === 409,
  );
  assert.equal(externalCalls, 0);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM project_launches').get().count, 0);
  db.close();
});

test('寻访启动：一次确认完成建群、接单行动和 OpenMai 触发', async () => {
  const db = readyDb();
  const events = [];
  const bus = { emit: (event) => events.push(event) };
  const dependencies = {
    appConfigured: true,
    ttcConnected: true,
    publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async () => ({ chat_id: 'oc_workflow', name: '项目群' }),
    ensureOpenClawGroupAllowed: async () => {},
    sendInteractiveCard: async () => ({ message_id: 'om_workflow' }),
    startOpenmaiTask: (store, passedBus, consultantId, projectId) => {
      assert.equal(store, db);
      assert.equal(passedBus, bus);
      assert.equal(consultantId, 'felix');
      assert.equal(projectId, PID);
      return { status: 'triggered', task_id: 'om_task', started_at: now() };
    },
  };
  const out = await launchRecruitingWorkflow(db, bus, 'felix', PID, {
    confirm: true, idempotency_key: 'workflow-1',
  }, dependencies);
  assert.equal(out.launch.search_status, 'RUNNING');
  assert.equal(out.launch.search_task_id, 'om_task');
  assert.equal(db.prepare(`SELECT state FROM current_engagement
    WHERE consultant_id='felix' AND project_id=?`).get(PID).state, 'ACCEPTED');
  const action = db.prepare(`SELECT title, goal FROM commitment_actions
    WHERE consultant_id='felix' AND project_id=? AND status='OPEN'`).get(PID);
  assert.match(action.title, /首轮候选人/);
  assert.match(action.goal, /搜索与匹配评估/);
  db.close();
});

test('寻访启动：缺确认或 TTC 凭证时不创建飞书群', async () => {
  const db = readyDb();
  let externalCalls = 0;
  const dependencies = {
    appConfigured: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    createProjectChat: async () => { externalCalls += 1; },
  };
  await assert.rejects(
    launchRecruitingWorkflow(db, null, 'felix', PID, { idempotency_key: 'no-confirm' }, dependencies),
    (error) => error.code === 'CONFIRM_REQUIRED',
  );
  await assert.rejects(
    launchRecruitingWorkflow(db, null, 'felix', PID, {
      confirm: true, idempotency_key: 'no-ttc',
    }, { ...dependencies, ttcConnected: false }),
    (error) => error.code === 'TTC_CREDENTIALS_REQUIRED',
  );
  assert.equal(externalCalls, 0);
  db.close();
});

test('寻访启动：候选不足后的明确重试才强制发起新一轮搜索', async () => {
  const db = readyDb();
  const at = now();
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,message_id,
     search_status,error_code,error_message,created_at,updated_at)
    VALUES ('launch-partial','felix',?,'first-click','READY','READY','oc_partial','om_job',
      'FAILED','OPENMAI_CANDIDATES_INCOMPLETE','不足 6 人',?,?)`).run(PID, at, at);
  let options;
  const out = await launchRecruitingWorkflow(db, null, 'felix', PID, {
    confirm: true, idempotency_key: 'retry-partial',
  }, {
    appConfigured: true, ttcConnected: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    startOpenmaiTask: (_store, _bus, _consultantId, _projectId, received) => {
      options = received;
      return { status: 'triggered', task_id: 'om_retry', started_at: at };
    },
  });
  assert.deepEqual(options, { force: true });
  assert.equal(out.launch.search_status, 'RUNNING');
  assert.equal(out.launch.error_code, null);
  db.close();
});

test('寻访启动：飞书投递耗尽后只重试投递，不重复运行 OpenMai', async () => {
  const db = readyDb();
  const at = now();
  db.prepare(`INSERT INTO project_launches
    (launch_id,consultant_id,project_id,idempotency_key,status,current_step,chat_id,message_id,
     search_status,error_code,error_message,created_at,updated_at)
    VALUES ('launch-delivery-failed','felix',?,'first-click','READY','READY','oc_failed','om_job',
      'FAILED','FEISHU_OPENMAI_DELIVERY_FAILED','投递失败',?,?)`).run(PID, at, at);
  let searchCalls = 0;
  let deliveryCalls = 0;
  const out = await launchRecruitingWorkflow(db, null, 'felix', PID, {
    confirm: true, idempotency_key: 'retry-delivery',
  }, {
    appConfigured: true, ttcConnected: true, publicBaseUrl: 'https://base.yorkteam.cn/',
    retryOpenmaiDelivery: () => {
      deliveryCalls++;
      return { status: 'delivery_retry', task_id: 'om_existing', started_at: at };
    },
    startOpenmaiTask: () => { searchCalls++; },
  });
  assert.equal(deliveryCalls, 1);
  assert.equal(searchCalls, 0);
  assert.equal(out.search.status, 'delivery_retry');
  assert.equal(out.launch.search_status, 'RUNNING');
  db.close();
});
