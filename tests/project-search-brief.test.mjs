import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { engage } from '../src/engagement.js';
import { getProjectSearchBrief, saveProjectSearchBrief, effectiveSearchBrief } from '../src/project-search-brief.js';
import { openmaiRoutes } from '../src/openmai-routes.js';
import { startOpenmaiTask } from '../src/openmai-task.js';
import { startSupermaiScoutTask } from '../src/supermai-sourcing.js';

function fixture(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const id = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1").get().project_id;
  return { db, id };
}
test('权威条件独立保存，不创建搜索；并发编辑不覆盖', t => {
  const { db, id } = fixture(t);
  assert.equal(getProjectSearchBrief(db, id).version, 0);
  assert.equal(saveProjectSearchBrief(db, 'felix', id, ' 北京，半导体 ', 0).version, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM openmai_results').get().n, 0);
  assert.throws(() => saveProjectSearchBrief(db, 'felix', id, '覆盖', 0), /CONFLICT/);
  assert.throws(() => saveProjectSearchBrief(db, 'felix', id, 'x'.repeat(2001), 1), /INVALID/);
  assert.equal(saveProjectSearchBrief(db, 'felix', id, '上海', 1).version, 2);
  assert.throws(() => saveProjectSearchBrief(db, 'felix', id, '旧版本覆盖', 1), /CONFLICT/);
  assert.equal(getProjectSearchBrief(db, id).search_brief, '上海');
});
test('本轮补充不覆盖权威条件，两渠道冻结同份条件；过长不截断', t => {
  const { db, id } = fixture(t);
  saveProjectSearchBrief(db, 'felix', id, '必须北京', 0);
  assert.match(effectiveSearchBrief(db, id, '优先芯片'), /必须北京.*\n.*优先芯片/);
  for (const run of [
    () => startOpenmaiTask(db, null, 'felix', id, { force: true, searchBrief: '优先芯片' }),
    () => startSupermaiScoutTask(db, null, 'felix', '优先芯片', { force: true, projectId: id }),
  ]) {
    run(); // fixture has no credential: must never call a paid endpoint
    const snapshot = db.prepare('SELECT search_brief FROM openmai_results WHERE project_id=?').get(id);
    assert.match(snapshot.search_brief, /必须北京.*\n.*优先芯片/);
  }
  assert.equal(getProjectSearchBrief(db, id).search_brief, '必须北京');
  assert.throws(() => effectiveSearchBrief(db, id, 'x'.repeat(2000)), /TOO_LONG/);
});
test('HTTP 读写需要已承接，冲突返回409，非法字段422', async t => {
  const { db, id } = fixture(t);
  const routes = openmaiRoutes(db, null);
  const call = async (method, payload = {}) => {
    let status, result;
    const res = { writeHead: value => { status = value; }, end: value => { result = JSON.parse(value); } };
    await routes[`${method} /api/v1/opportunities/:id/search-brief`](Readable.from([Buffer.from(JSON.stringify(payload))]), res, 'felix', {}, id);
    return { status, result };
  };
  assert.equal((await call('GET')).status, 404);
  assert.equal(engage(db, 'felix', id, 'ACCEPT', { confirm: true, idempotency_key: 'brief-test' }).ok, true);
  assert.equal((await call('PUT', { search_brief: '北京', version: 0 })).status, 200);
  assert.equal((await call('PUT', { search_brief: '旧版本', version: 0 })).status, 409);
  assert.equal((await call('PUT', { search_brief: [], version: 1 })).status, 422);
  assert.equal((await call('GET')).result.search_brief, '北京');
});
