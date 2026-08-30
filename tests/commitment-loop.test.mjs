import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { currentState } from '../src/engagement.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import {
  acceptCommitment,
  commitmentDetails,
  recordProgress,
  recordTerminalResult,
  releaseCommitment,
  suggestedAction,
} from '../src/commitment.js';

const CID = 'felix';
const PID = 'P-COMMITMENT-LOOP';
let db;

function seedVisibleJob() {
  db.prepare(`INSERT INTO sync_runs
    (sync_id, consultant_id, source, as_of, rows_expected, rows_read, complete,
     errors, input_hash, schema_version, started_at, completed_at)
    VALUES ('sync-loop', ?, 'fixture', ?, 1, 1, 1, '[]', 'loop', '1.0', ?, ?)`)
    .run(CID, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO job_facts
    (project_id, company, role, city, pipeline, hc, active_state, source_url,
     captured_at, sync_id, raw_json, updated_at)
    VALUES (?, '闭环科技', '增长负责人', '上海', '面试', 1, 'OPEN', NULL, ?,
            'sync-loop', '{}', ?)`)
    .run(PID, new Date().toISOString(), new Date().toISOString());
  db.prepare(`INSERT INTO job_memberships
    (consultant_id, project_id, relation, source, valid_from)
    VALUES (?, ?, 'MY_JOB', 'test', ?)`)
    .run(CID, PID, new Date().toISOString());
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, idempotency_key, prev_state, next_state, payload_json)
    VALUES ('recommended-loop', 'RECOMMENDED', ?, ?, ?, 'recommended:loop', 'NEW', 'RECOMMENDED', '{}')`)
    .run(CID, new Date().toISOString(), PID);
}

beforeEach(() => {
  db = openDb(':memory:');
  seedVisibleJob();
});

test('接单必须同时提供目标、第一行动和未来 90 天内截止时间', () => {
  const missing = acceptCommitment(db, CID, PID, {
    idempotency_key: 'accept:missing', goal: '推进到面试', action_title: '', due_at: '',
  });
  assert.equal(missing.status, 422);
  assert.equal(currentState(db, CID, PID).state, 'RECOMMENDED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM commitment_actions').get().n, 0);

  const tooLate = new Date(Date.now() + 91 * 86400000).toISOString();
  const invalid = acceptCommitment(db, CID, PID, {
    idempotency_key: 'accept:late', goal: '推进到面试', action_title: '联系客户', due_at: tooLate,
  });
  assert.equal(invalid.status, 422);
  assert.equal(currentState(db, CID, PID).state, 'RECOMMENDED');
});

test('接单原子写入目标与唯一当前行动，重复幂等键不重复写入', () => {
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const input = { idempotency_key: 'accept:ok', goal: '确认面试安排', action_title: '向客户确认反馈', due_at: due };
  const first = acceptCommitment(db, CID, PID, input);
  assert.equal(first.ok, true);
  assert.equal(first.state, 'ACCEPTED');
  assert.equal(first.active_action.title, '向客户确认反馈');
  const dup = acceptCommitment(db, CID, PID, input);
  assert.equal(dup.ok, true);
  assert.equal(dup.already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM commitment_actions').get().n, 1);
  assert.equal(commitmentDetails(db, CID, PID).commitment_goal, '确认面试安排');
});

test('历史已接单但缺少行动时可补建，不改写原 ACCEPTED 事件', () => {
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, idempotency_key, prev_state, next_state, payload_json)
    VALUES ('legacy-accepted', 'ACCEPTED', ?, '2026-01-02T03:04:05.000Z', ?, 'legacy:accepted', 'WATCHED', 'ACCEPTED', '{}')`)
    .run(CID, PID);
  const repaired = acceptCommitment(db, CID, PID, {
    idempotency_key: 'accept:repair', goal: '恢复当前推进', action_title: '确认客户最新反馈',
    due_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.repaired, true);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM decision_events WHERE event_type='ACCEPTED' AND actor=? AND project_id=?`).get(CID, PID).n, 1);
  assert.equal(commitmentDetails(db, CID, PID).commitment_goal, '恢复当前推进');
});

test('普通进展必须原子完成旧行动、记录结果并创建下一行动', () => {
  const due = new Date(Date.now() + 2 * 86400000).toISOString();
  const accepted = acceptCommitment(db, CID, PID, {
    idempotency_key: 'accept:progress', goal: '推进候选人', action_title: '确认首轮反馈', due_at: due,
  });
  const rejected = recordProgress(db, CID, PID, {
    idempotency_key: 'progress:missing-next', action_id: accepted.active_action.action_id,
    kind: 'STAGE', stage: '面试', summary: '客户确认进入下一轮',
  });
  assert.equal(rejected.status, 422);
  assert.equal(db.prepare(`SELECT status FROM commitment_actions WHERE action_id=?`).get(accepted.active_action.action_id).status, 'OPEN');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_outcomes').get().n, 0);

  const nextDue = new Date(Date.now() + 3 * 86400000).toISOString();
  const progressed = recordProgress(db, CID, PID, {
    idempotency_key: 'progress:ok', action_id: accepted.active_action.action_id,
    kind: 'STAGE', stage: '面试', summary: '客户确认进入下一轮', rating: 4,
    next_action: { title: '确认二面时间', due_at: nextDue, source: 'RULE' },
  });
  assert.equal(progressed.ok, true);
  assert.equal(db.prepare(`SELECT status FROM commitment_actions WHERE action_id=?`).get(accepted.active_action.action_id).status, 'DONE');
  assert.equal(progressed.active_action.title, '确认二面时间');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_outcomes').get().n, 1);
});

test('规则建议固定可审计，真实 next_action 优先', () => {
  const interview = suggestedAction(db, CID, PID, { stage: '面试' });
  assert.match(interview.title, /反馈.*下一轮/);
  assert.equal(interview.source, 'RULE');
  const blocked = suggestedAction(db, CID, PID, { kind: 'BLOCKED' });
  assert.match(blocked.title, /解除阻塞/);
});

test('Offer 不能完成承接；只有入职或关闭可终局，关闭必须原因', () => {
  const accepted = acceptCommitment(db, CID, PID, {
    idempotency_key: 'accept:terminal', goal: '完成交付', action_title: '跟进 Offer',
    due_at: new Date(Date.now() + 86400000).toISOString(),
  });
  const offer = recordTerminalResult(db, CID, PID, {
    idempotency_key: 'terminal:offer', stage: 'Offer', summary: '已发 Offer',
  });
  assert.equal(offer.status, 422);
  assert.equal(currentState(db, CID, PID).state, 'ACCEPTED');
  const missingReason = recordTerminalResult(db, CID, PID, {
    idempotency_key: 'terminal:close-missing', stage: '关闭', summary: '客户结束招聘',
  });
  assert.equal(missingReason.status, 422);
  const closed = recordTerminalResult(db, CID, PID, {
    idempotency_key: 'terminal:close', stage: '关闭', close_reason: '职位关闭', summary: '客户确认职位关闭',
  });
  assert.equal(closed.ok, true);
  assert.equal(currentState(db, CID, PID).state, 'COMPLETED');
  assert.equal(db.prepare('SELECT status FROM commitment_actions WHERE action_id=?').get(accepted.active_action.action_id).status, 'DONE');
});

test('释放必须合法原因与说明，并取消当前行动', () => {
  const accepted = acceptCommitment(db, CID, PID, {
    idempotency_key: 'accept:release', goal: '完成交付', action_title: '确认资源',
    due_at: new Date(Date.now() + 86400000).toISOString(),
  });
  const invalid = releaseCommitment(db, CID, PID, {
    idempotency_key: 'release:bad', reason: '随便', summary: '先不做了',
  });
  assert.equal(invalid.status, 422);
  const released = releaseCommitment(db, CID, PID, {
    idempotency_key: 'release:ok', reason: '资源不足', summary: '本周没有可投入人选',
  });
  assert.equal(released.ok, true);
  assert.equal(released.state, 'RELEASED');
  assert.equal(db.prepare('SELECT status FROM commitment_actions WHERE action_id=?').get(accepted.active_action.action_id).status, 'CANCELLED');
});

test('历史 COMPLETED 缺终局结果时只补录，不改变原完成时间', () => {
  db.prepare(`INSERT INTO decision_events
    (event_id, event_type, actor, occurred_at, project_id, idempotency_key, prev_state, next_state, payload_json)
    VALUES ('legacy-complete', 'COMPLETED', ?, '2026-01-02T03:04:05.000Z', ?, 'legacy:complete', 'ACCEPTED', 'COMPLETED', '{}')`)
    .run(CID, PID);
  assert.equal(commitmentDetails(db, CID, PID).terminal_result_missing, true);
  const out = recordTerminalResult(db, CID, PID, {
    idempotency_key: 'terminal:backfill', stage: '入职', summary: '候选人已于一月入职',
  });
  assert.equal(out.ok, true);
  assert.equal(out.backfilled, true);
  const completed = db.prepare(`SELECT occurred_at FROM decision_events WHERE event_id='legacy-complete'`).get();
  assert.equal(completed.occurred_at, '2026-01-02T03:04:05.000Z');
  assert.equal(commitmentDetails(db, CID, PID).terminal_result_missing, false);
});

test('HTTP 契约：接单校验、详情扩展、拒绝直接 COMPLETE 与跨顾问读取', async (t) => {
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `brainx_session=${encodeURIComponent(signSession(CID, 'ou_felix'))}`, 'Content-Type': 'application/json' };
  const post = (suffix, body) => fetch(`${base}/api/v1/opportunities/${PID}/${suffix}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });

  const missing = await post('engagement', { action: 'ACCEPT', idempotency_key: 'http:accept:missing' });
  assert.equal(missing.status, 422);
  const accepted = await post('engagement', {
    action: 'ACCEPT', idempotency_key: 'http:accept', goal: '确认下一轮',
    action_title: '联系客户', due_at: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.equal(accepted.status, 200);
  const direct = await post('engagement', { action: 'COMPLETE', idempotency_key: 'http:complete' });
  assert.equal(direct.status, 422);

  const detail = await fetch(`${base}/api/v1/opportunities/${PID}`, { headers });
  assert.equal(detail.status, 200);
  const payload = await detail.json();
  assert.equal(payload.commitment_goal, '确认下一轮');
  assert.equal(payload.active_action.title, '联系客户');
  assert.ok(Array.isArray(payload.action_history));
  assert.equal(payload.action_history.length, 0);
  assert.equal(payload.legal_actions.includes('COMPLETE'), false);

  const otherHeaders = { Cookie: `brainx_session=${encodeURIComponent(signSession('mia', 'ou_mia'))}` };
  const hidden = await fetch(`${base}/api/v1/opportunities/${PID}`, { headers: otherHeaders });
  assert.equal(hidden.status, 404);
});
