import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  buildScoutPrompt,
  getSupermaiResult,
  getSupermaiTask,
  startSupermaiScoutTask,
  supermaiCriteriaKey,
} from '../src/supermai-sourcing.js';
import {
  authenticateSupermaiDevice,
  claimSupermaiPairCode,
  createSupermaiPairCode,
  finishSupermaiTask,
  ingestSupermaiResults,
  pollSupermaiRelay,
  queueSupermaiLogin,
  reportSupermaiRelay,
  supermaiDeviceStatus,
} from '../src/supermai-relay.js';

const CRITERIA = '北京 5年 React 资深前端工程师';

function paired(db, consultantId = 'felix') {
  const pair = createSupermaiPairCode(db, consultantId);
  const claimed = claimSupermaiPairCode(db, {
    code: pair.code, name: 'Felix Mac', platform: 'darwin', connector_version: '1.0.0',
  });
  const device = authenticateSupermaiDevice(db, `Bearer ${claimed.device_token}`);
  return { ...claimed, device };
}

const local = {
  available: true,
  busy: false,
  version: '0.3.6',
  platforms: {
    boss: { running: true, logged_in: true },
    maimai: { running: false, logged_in: false },
    liepin: { running: false, logged_in: null },
  },
};

test('判据键稳定，排除名单进入桌面任务判据', () => {
  const a = supermaiCriteriaKey('  北京 5年 React 资深前端  ');
  assert.equal(a, supermaiCriteriaKey('北京 5年 React 资深前端'));
  assert.notEqual(a, supermaiCriteriaKey('上海 5年 React 资深前端'));
  const prompt = buildScoutPrompt(CRITERIA, ['boss:old']);
  assert.match(prompt, /北京 5年 React/);
  assert.match(prompt, /排除已推荐候选人：boss:old/);
  assert.doesNotMatch(prompt, /OpenMai|completions/);
});

test('无桌面设备时真实排队，不读取 TTC 凭证也不调用 OpenMai', () => {
  const db = openDb(':memory:');
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('不应调用网络'); };
  try {
    const output = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(output.status, 'triggered');
    assert.equal(output.task_status, 'waiting_for_device');
    assert.match(output.task_id, /^sm_/);
    assert.equal(calls, 0);
    const task = getSupermaiTask(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(task.status, 'waiting_for_device');
    assert.deepEqual(JSON.parse(task.platforms_json), ['boss', 'maimai', 'liepin']);
    const result = getSupermaiResult(db, 'felix', supermaiCriteriaKey(CRITERIA));
    assert.equal(result.status, 'running');
    assert.equal(result.task_id, output.task_id);
    const duplicate = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
    assert.equal(duplicate.status, 'running');
    assert.equal(duplicate.task_id, output.task_id);
  } finally {
    global.fetch = original;
  }
});

test('配对码一次性使用，设备 token 可独立撤销与鉴权', () => {
  const db = openDb(':memory:');
  const pair = createSupermaiPairCode(db, 'felix');
  const first = claimSupermaiPairCode(db, {
    code: pair.code, name: 'Felix Mac', platform: 'darwin', connector_version: '1.0.0',
  });
  assert.ok(first.device_token);
  assert.equal(claimSupermaiPairCode(db, { code: pair.code }), null, '同一码不可重放');
  assert.equal(authenticateSupermaiDevice(db, `Bearer ${first.device_token}`).device_id, first.device_id);
  assert.equal(authenticateSupermaiDevice(db, 'Bearer wrong'), null);
  assert.equal(supermaiDeviceStatus(db, 'felix').registered, true);
});

test('桌面轮询只领取本人任务，并按已登录平台缩小执行范围', () => {
  const db = openDb(':memory:');
  const auth = paired(db);
  const created = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
  startSupermaiScoutTask(db, null, 'mia', '上海 Java 后端工程师');
  const message = pollSupermaiRelay(db, auth.device, {
    connector_version: '1.0.0', local,
  });
  assert.equal(message.kind, 'sourcing_task');
  assert.equal(message.task_id, created.task_id);
  assert.deepEqual(message.platforms, ['boss']);
  assert.ok(message.ingest_token);
  const task = db.prepare('SELECT status,device_id,platforms_json FROM sourcing_tasks WHERE task_id=?')
    .get(created.task_id);
  assert.equal(task.status, 'running');
  assert.equal(task.device_id, auth.device_id);
  assert.deepEqual(JSON.parse(task.platforms_json), ['boss']);
  assert.equal(getSupermaiTask(db, 'mia', supermaiCriteriaKey('上海 Java 后端工程师')).status,
    'waiting_for_device');
});

test('候选人 ingest 幂等，finish 定稿为统一候选人块且关闭后拒绝继续写', () => {
  const db = openDb(':memory:');
  const auth = paired(db);
  const created = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
  const message = pollSupermaiRelay(db, auth.device, { local });
  const batch = {
    platform: 'boss',
    round: 1,
    items: [{
      platform: 'boss', external_id: 'boss:abc', name: '张三', company: 'Acme',
      title: '高级前端', city: '北京', years: 6, edu_school: '北航', edu_degree: '本科',
      skills: ['React', 'TypeScript'], profile_url: 'https://evil.example/phishing',
      raw: { cookie: '不得落库' },
    }],
  };
  assert.deepEqual(ingestSupermaiResults(db, created.task_id, message.ingest_token, batch), {
    accepted: 1, deduped: 0, statuses: {},
  });
  assert.deepEqual(ingestSupermaiResults(db, created.task_id, message.ingest_token, batch), {
    accepted: 0, deduped: 1, statuses: {},
  });
  const stored = db.prepare('SELECT payload_json FROM sourcing_results WHERE task_id=?').get(created.task_id);
  assert.doesNotMatch(stored.payload_json, /cookie|evil\.example/);
  const done = finishSupermaiTask(db, created.task_id, message.ingest_token, {
    status: 'done', platform_counts: { boss: 1 },
  });
  assert.deepEqual(done, { status: 'completed', result_count: 1 });
  const result = getSupermaiResult(db, 'felix', supermaiCriteriaKey(CRITERIA));
  assert.equal(result.status, 'done');
  assert.match(result.result_text, /张三/);
  assert.match(result.result_text, /BRAINX_CANDIDATES_V1/);
  assert.doesNotMatch(result.result_text, /cookie/);
  assert.deepEqual(finishSupermaiTask(db, created.task_id, message.ingest_token, { status: 'done' }),
    done, 'finish 重放幂等');
  assert.equal(ingestSupermaiResults(db, created.task_id, message.ingest_token, batch), null,
    '定稿后 token 不可继续 ingest');
});

test('官方登录动作经设备命令队列下发，不由云端访问 localhost', () => {
  const db = openDb(':memory:');
  const auth = paired(db);
  pollSupermaiRelay(db, auth.device, { local });
  const queued = queueSupermaiLogin(db, 'felix', 'maimai');
  assert.equal(queued.platform, 'maimai');
  assert.equal(queueSupermaiLogin(db, 'felix', 'evil'), null);
  const command = pollSupermaiRelay(db, auth.device, { local });
  assert.equal(command.kind, 'command');
  assert.deepEqual(command.payload, { platform: 'maimai' });
  assert.deepEqual(reportSupermaiRelay(db, auth.device, {
    command_id: command.command_id, status: 'completed',
  }), { ok: true });
});

test('桌面启动失败时任务与兼容结果同时失败，避免永久 running', () => {
  const db = openDb(':memory:');
  const auth = paired(db);
  const created = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
  pollSupermaiRelay(db, auth.device, { local });
  assert.deepEqual(reportSupermaiRelay(db, auth.device, {
    task_id: created.task_id, status: 'failed', error: 'BOSS 登录失效',
  }), { ok: true });
  assert.equal(getSupermaiTask(db, 'felix', supermaiCriteriaKey(CRITERIA)).status, 'failed');
  const result = getSupermaiResult(db, 'felix', supermaiCriteriaKey(CRITERIA));
  assert.equal(result.status, 'failed');
  assert.match(result.error, /BOSS 登录失效/);
});

test('SuperMai 与同职位 OpenMai 结果分开，不会把旧渠道结果当成已完成', () => {
  const db = openDb(':memory:');
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,task_id,result_text,started_at,finished_at)
    VALUES ('project-shared','felix','done','om_existing','OpenMai 旧结果',?,?)`)
    .run(at, at);
  const created = startSupermaiScoutTask(db, null, 'felix', CRITERIA, {
    projectId: 'project-shared',
  });
  assert.equal(created.status, 'triggered');
  assert.match(created.task_id, /^sm_/);
  assert.equal(db.prepare(`SELECT result_text FROM openmai_results
    WHERE project_id='project-shared' AND consultant_id='felix'`).get().result_text, 'OpenMai 旧结果');
  assert.equal(getSupermaiResult(db, 'felix', 'project-shared').task_id, created.task_id);
});

test('桌面中断后过期租约可重新领取，旧 ingest token 立即失效', () => {
  const db = openDb(':memory:');
  const auth = paired(db);
  const created = startSupermaiScoutTask(db, null, 'felix', CRITERIA);
  const first = pollSupermaiRelay(db, auth.device, { local }, { leaseMs: 1 });
  assert.equal(first.kind, 'sourcing_task');
  db.prepare(`UPDATE sourcing_tasks SET lease_expires_at='2000-01-01T00:00:00.000Z'
    WHERE task_id=?`).run(created.task_id);
  assert.equal(ingestSupermaiResults(db, created.task_id, first.ingest_token, {
    platform: 'boss', items: [],
  }), null, '过期租约未重领前也不可继续写入');
  const second = pollSupermaiRelay(db, auth.device, { local });
  assert.equal(second.kind, 'sourcing_task');
  assert.equal(second.task_id, created.task_id);
  assert.notEqual(second.ingest_token, first.ingest_token);
  assert.equal(ingestSupermaiResults(db, created.task_id, first.ingest_token, {
    platform: 'boss', items: [],
  }), null);
});
