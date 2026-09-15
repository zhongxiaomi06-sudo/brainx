/** 2026-09-15 群权限放开：职位绑定群里的任何已登记顾问都能点找人/接单；
 * 私聊与非绑定群仍 fail-closed。不触网。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { jobAccessibleFromGroup } from '../src/visibility.js';
import { createActionToolHandlers } from '../src/agent-gateway/tools-actions.js';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const job = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' LIMIT 1`).get();
  db.prepare('UPDATE job_facts SET chat_id=? WHERE project_id=?').run('oc_bound', job.project_id);
  const searches = [];
  const handlers = createActionToolHandlers({ db, startSearchFn: (_db, consultantId, jobId, options) => {
    searches.push({ consultantId, jobId, options });
    return { status: 'triggered', task_id: 'search-1' };
  } });
  const inGroup = { principal: { tenantId: 'tenant-a', consultantId: 'mia', chatType: 'group', chatId: 'oc_bound' } };
  return { db, jobId: job.project_id, handlers, searches, inGroup };
}

test('jobAccessibleFromGroup：仅绑定群（job_facts.chat_id 或 READY project_launches）命中', () => {
  const { db, jobId } = fixture();
  assert.equal(jobAccessibleFromGroup(db, { chatType: 'group', chatId: 'oc_bound' }, jobId), true);
  assert.equal(jobAccessibleFromGroup(db, { chatType: 'group', chatId: 'oc_other' }, jobId), false);
  assert.equal(jobAccessibleFromGroup(db, { chatType: 'p2p', chatId: 'oc_bound' }, jobId), false,
    '私聊上下文不放行');
  // job_facts.chat_id 为空但存在 READY 项目群记录时也命中
  db.prepare('UPDATE job_facts SET chat_id=NULL WHERE project_id=?').run(jobId);
  assert.equal(jobAccessibleFromGroup(db, { chatType: 'group', chatId: 'oc_bound' }, jobId), false);
  db.prepare(`INSERT INTO project_launches (launch_id, consultant_id, project_id, idempotency_key, status, current_step, chat_id, created_at, updated_at)
    VALUES ('l-g1', 'felix', ?, 'kg1', 'READY', 'READY', 'oc_launch', ?, ?)`).run(jobId, now(), now());
  assert.equal(jobAccessibleFromGroup(db, { chatType: 'group', chatId: 'oc_launch' }, jobId), true);
  // intake 绑定群同样命中（一职位多群实证：chat_id 被后续 launch 覆盖后，intake 绑定事实仍在）
  db.prepare(`INSERT INTO bot_chat_intake (chat_id, chat_name, status, project_id, first_seen_at, updated_at)
    VALUES ('oc_intake', '旧群', 'BOUND', ?, ?, ?)`).run(jobId, now(), now());
  assert.equal(jobAccessibleFromGroup(db, { chatType: 'group', chatId: 'oc_intake' }, jobId), true);
  db.close();
});

test('绑定群里非职位成员点击找人：放行且按项目级搜索触发，不要求本人接单', () => {
  const { db, jobId, handlers, searches, inGroup } = fixture();
  const out = handlers.brainx_start_candidate_search({ job_id: jobId, confirm: true }, inGroup);
  assert.equal(out.data.search.status, 'triggered');
  assert.deepEqual(searches, [{ consultantId: 'mia', jobId, options: { force: false } }]);
  db.close();
});

test('同一非成员在私聊或非绑定群里仍 fail-closed', () => {
  const { db, jobId, handlers } = fixture();
  assert.throws(() => handlers.brainx_start_candidate_search({ job_id: jobId, confirm: true },
    { principal: { tenantId: 'tenant-a', consultantId: 'mia', chatType: 'p2p', chatId: 'ou_mia' } }),
    /NOT_FOUND_OR_FORBIDDEN/);
  assert.throws(() => handlers.brainx_start_candidate_search({ job_id: jobId, confirm: true },
    { principal: { tenantId: 'tenant-a', consultantId: 'mia', chatType: 'group', chatId: 'oc_stranger' } }),
    /NOT_FOUND_OR_FORBIDDEN/);
  db.close();
});

test('绑定群里非成员可自助接单：落本人 ACCEPTED 与 MY_JOB 成员关系', () => {
  const { db, jobId, handlers, inGroup } = fixture();
  const out = handlers.brainx_accept_job({ job_id: jobId, confirm: true }, inGroup);
  assert.equal(out.data.state, 'ACCEPTED');
  assert.equal(db.prepare(`SELECT relation FROM job_memberships
    WHERE consultant_id='mia' AND project_id=? AND valid_to IS NULL`).get(jobId)?.relation, 'MY_JOB');
  db.close();
});
