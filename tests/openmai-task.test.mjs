import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { settleOpenmaiTask } from '../src/openmai-task.js';

function runningTask() {
  const db = openDb(':memory:');
  const at = now();
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,task_id,started_at)
    VALUES ('P-RACE','felix','running','om_new',?)`).run(at);
  return db;
}

test('OpenMai 旧任务结束不得覆盖同职位的新任务', () => {
  const db = runningTask();
  const changed = settleOpenmaiTask(db, {
    projectId: 'P-RACE', consultantId: 'felix', taskId: 'om_old',
    status: 'failed', error: '旧进程超时',
  });
  assert.equal(changed, false);
  assert.deepEqual({ ...db.prepare(`SELECT status,task_id,result_text,error,finished_at
    FROM openmai_results`).get() }, {
    status: 'running', task_id: 'om_new', result_text: null, error: null, finished_at: null,
  });
  db.close();
});

test('OpenMai 只有当前运行任务可以落成功或失败终态', () => {
  const db = runningTask();
  assert.equal(settleOpenmaiTask(db, {
    projectId: 'P-RACE', consultantId: 'felix', taskId: 'om_new',
    status: 'done', resultText: '候选结果', finishedAt: '2026-09-07T14:30:00.000Z',
  }), true);
  assert.deepEqual({ ...db.prepare(`SELECT status,result_text,error,finished_at FROM openmai_results`).get() }, {
    status: 'done', result_text: '候选结果', error: null, finished_at: '2026-09-07T14:30:00.000Z',
  });
  assert.equal(settleOpenmaiTask(db, {
    projectId: 'P-RACE', consultantId: 'felix', taskId: 'om_new',
    status: 'failed', error: '迟到错误',
  }), false, '已完成任务也不得被迟到回调改写');
  db.close();
});
