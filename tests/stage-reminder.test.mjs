import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { acceptCommitment } from '../src/commitment.js';
import { collectStageReminders, buildStageReminderCard,
  remindStagesOnce, inStageSendWindow, stageDayKey } from '../src/stage-reminder.js';

// 全部用固定时刻（CST 工作日 2026-09-10 周四）：13:00 CST = 05:00 UTC（窗口内）
const AT = new Date('2026-09-10T05:00:00.000Z');
const OLD = new Date(Date.parse(AT) - 30 * 3600000).toISOString(); // 30h 前（>24h 静默）
const RECENT = new Date(Date.parse(AT) - 2 * 3600000).toISOString(); // 2h 前（<24h）

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const projectId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1")
    .get().project_id;
  return { db, projectId };
}

/** 建一个 ACCEPTED 项目并把活动回拨到 30h 前（静默成立）。 */
function seedAcceptedProject(db, projectId, { consultantId = 'felix' } = {}) {
  const accepted = acceptCommitment(db, consultantId, projectId, {
    goal: '两周内交付 5 名匹配候选人',
    action_title: '启动找人并确认首批候选人',
    // 截止时间锚定「现在 + 3 天」而非 AT：用固定日期会在该日期过后变成
    // 「截止时间必须晚于现在」的时间炸弹（2026-09-13 13:00 实证）。
    due_at: new Date(Date.now() + 3 * 86400000).toISOString(),
    idempotency_key: `fixture:accept:${projectId}:${consultantId}`,
  });
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);
  db.prepare('UPDATE decision_events SET occurred_at=? WHERE project_id=? AND event_type=?')
    .run(OLD, projectId, 'ACCEPTED');
  backdateActivity(db, projectId);
}

function backdateActivity(db, projectId) {
  for (const [sql, ...args] of [
    ['UPDATE decision_events SET occurred_at=? WHERE project_id=?', OLD, projectId],
    ['UPDATE commitment_actions SET created_at=?, updated_at=? WHERE project_id=?', OLD, OLD, projectId],
    ['UPDATE job_outcomes SET observed_at=? WHERE project_id=?', OLD, projectId],
    ['UPDATE openmai_results SET started_at=?, finished_at=? WHERE project_id=?', OLD, OLD, projectId],
  ]) db.prepare(sql).run(...args);
}

const felix = (db) => collectStageReminders(db, AT).filter((x) => x.consultant_id === 'felix');
const phases = (db) => felix(db).map((x) => x.phase).sort();

test('阶段 A：无 ACCEPTED 承接 → 每人一张；有 ACCEPTED → 不发；偏好关闭 → 跳过', () => {
  const { db, projectId } = fixture();
  assert.deepEqual(phases(db), ['A'], 'felix 无接单 → A 阶段候选');
  const a = collectStageReminders(db, AT)[0];
  assert.equal(a.run_id, `stage:A:-:${stageDayKey(AT)}`, 'A 阶段 run_id 日键');

  seedAcceptedProject(db, projectId);
  assert.deepEqual(phases(db), ['B'], '有 ACCEPTED 承接 → 不再发 A（转入 B）');

  // 偏好关闭：释放承接后 felix 偏好 disabled → 跳过
  db.prepare("UPDATE decision_events SET next_state='RELEASED' WHERE project_id=? AND event_type='ACCEPTED'")
    .run(projectId);
  db.prepare(`UPDATE consultants SET profile_json=? WHERE consultant_id='felix'`)
    .run(JSON.stringify({ push_preferences: { enabled: false } }));
  assert.deepEqual(felix(db), [], '推送偏好关闭 → 全阶段跳过');
});

test('阶段 B：接单未找人 + 静默超 24h → 候选；刚接单 → 不候选', () => {
  const { db, projectId } = fixture();
  seedAcceptedProject(db, projectId);
  assert.deepEqual(phases(db), ['B'], '接单无找人结果 → B');
  assert.equal(felix(db)[0].project_id, projectId);

  // 刚接单（state_since 拨回 2h 前）→ 静默不足
  db.prepare("UPDATE decision_events SET occurred_at=? WHERE project_id=? AND event_type='ACCEPTED'")
    .run(RECENT, projectId);
  assert.deepEqual(phases(db), [], '刚接单 2h → 不打扰');

  db.prepare("UPDATE decision_events SET occurred_at=? WHERE project_id=? AND event_type='ACCEPTED'")
    .run(OLD, projectId);
  // 找人结果已存在 → 升级为 C（或因推进信号消失）
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?, 'felix', 'done', '候选人列表', 't1', ?, ?)`)
    .run(projectId, OLD, OLD);
  assert.deepEqual(phases(db), ['C'], '有找人结果 → C');
});

test('阶段 C：有结果无推进 → 候选；记录 outcome 或建群后 → 不候选', () => {
  const { db, projectId } = fixture();
  seedAcceptedProject(db, projectId);
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?, 'felix', 'done', '候选人列表', 't1', ?, ?)`)
    .run(projectId, OLD, OLD);
  assert.deepEqual(phases(db), ['C'], '无推进信号 → C 候选');

  db.prepare(`INSERT INTO job_outcomes (project_id, consultant_id, stage, value_json, idempotency_key, observed_at)
    VALUES (?, 'felix', '推荐采纳', '{}', 'fixture:o1', ?)`).run(projectId, RECENT);
  assert.deepEqual(phases(db), [], '有结果记录 → 已推进，不打扰');
});

test('时间门：周末不发；12:30 前不发；21:00 后不发；窗口内补发', () => {
  assert.equal(inStageSendWindow(new Date('2026-09-12T05:00:00.000Z'), '12:30'), false, '周六不发');
  assert.equal(inStageSendWindow(new Date('2026-09-13T05:00:00.000Z'), '12:30'), false, '周日不发');
  assert.equal(inStageSendWindow(new Date('2026-09-10T03:00:00.000Z'), '12:30'), false, 'CST 11:00 未到点');
  assert.equal(inStageSendWindow(new Date('2026-09-10T13:30:00.000Z'), '12:30'), false, 'CST 21:30 过窗');
  assert.equal(inStageSendWindow(AT, '12:30'), true, 'CST 13:00 在窗（补发）');
  assert.equal(inStageSendWindow(new Date('2026-09-10T04:31:00.000Z'), '12:30'), true, 'CST 12:31 到点即发');
});

test('remindStagesOnce：窗口外 closed；窗口内幂等不重发；FAILED 可重试', async () => {
  const { db, projectId } = fixture();
  seedAcceptedProject(db, projectId);
  db.prepare(`INSERT INTO openmai_results (project_id, consultant_id, status, result_text, task_id, started_at, finished_at)
    VALUES (?, 'felix', 'done', '候选人列表', 't1', ?, ?)`)
    .run(projectId, OLD, OLD);

  db.prepare(`UPDATE consultants SET profile_json=? WHERE consultant_id!='felix'`)
    .run(JSON.stringify({ push_preferences: { enabled: false } }));
  const closed = await remindStagesOnce(db, { at: new Date('2026-09-13T05:00:00.000Z'), send: false });
  assert.equal(closed.window, 'closed', '周日窗口关闭');

  const first = await remindStagesOnce(db, { at: AT, send: true, publicBaseUrl: 'https://app.ttcadvisory.com',
    sendImpl: async () => ({ message_id: 'om_ok1' }) });
  assert.equal(first.sent, 1, '首轮发送 1 张（C 阶段）');
  const second = await remindStagesOnce(db, { at: AT, send: true, publicBaseUrl: 'https://app.ttcadvisory.com',
    sendImpl: async () => ({ message_id: 'om_ok2' }) });
  assert.equal(second.sent, 0, '同日重扫幂等不重发');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_log WHERE kind='STAGE_REMINDER'").get().n, 1);
  assert.equal(db.prepare("SELECT target FROM push_log WHERE kind='STAGE_REMINDER'").get().target,
    'ou_3b30bc83806e157d9af0cd9188d7ab8d', 'DM 目标 = 顾问 open_id');

  // 失败重试：换一天重置日键，先失败后成功
  const nextDay = new Date(Date.parse(AT) + 86400000); // 周五同时刻
  const bad = await remindStagesOnce(db, { at: nextDay, send: true, publicBaseUrl: 'https://app.ttcadvisory.com',
    sendImpl: async () => { throw new Error('FEISHU_DOWN'); } });
  assert.equal(bad.failed, 1, '发送失败计入 failed');
  const good = await remindStagesOnce(db, { at: nextDay, send: true, publicBaseUrl: 'https://app.ttcadvisory.com',
    sendImpl: async () => ({ message_id: 'om_ok3' }) });
  assert.equal(good.sent, 1, '同日 FAILED 下一轮重试成功');
});

test('卡片：三阶段文案与深链按钮齐备', () => {
  const base = { publicBaseUrl: 'https://app.ttcadvisory.com' };
  const mk = (phase) => buildStageReminderCard({
    phase, consultant_id: 'felix', display_name: 'Felix 黄鑫', open_id: 'ou_x',
    project_id: 'job-1', company: '物外智趣', role: '增长投放',
    run_id: `stage:${phase}:job-1:2026-09-10`,
  }, base);
  const a = JSON.stringify(mk('A'));
  assert.ok(a.includes('今天想看什么岗位吗'), 'A 文案');
  assert.ok(a.includes('打开工作台'), 'A 工作台按钮');
  assert.ok(!a.includes('oc_'), '卡片不泄露 chat_id');
  const b = JSON.stringify(mk('B'));
  assert.ok(b.includes('现在想找人吗'), 'B 文案');
  assert.ok(b.includes('还没有启动找人'), 'B 说明找人未启动');
  const c = JSON.stringify(mk('C'));
  assert.ok(c.includes('要找新的人吗'), 'C 文案');
  assert.ok(c.includes('app.ttcadvisory.com'), '深链按钮指向工作台');
});
