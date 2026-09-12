import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { acceptCommitment } from '../src/commitment.js';
import { collectProjectReminders, buildProjectReminderCard,
  remindProjectsOnce, inSendWindow, reminderWeekKey } from '../src/project-reminder.js';

const TEST_NOW = '2026-09-10T03:00:00.000Z'; // CST 11:00
const OLD = new Date(Date.parse(TEST_NOW) - 96 * 3600000).toISOString(); // 96h 前（>72h 阈值）
const RECENT = new Date(Date.parse(TEST_NOW) - 3600000).toISOString(); // 1h 前

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const projectId = db.prepare("SELECT project_id FROM job_memberships WHERE consultant_id='felix' LIMIT 1")
    .get().project_id;
  return { db, projectId };
}

/** 建一个「可提醒」项目：READY 项目群 + ACCEPTED 承接，且把全部活动回拨到 96h 前。 */
function seedReminderProject(db, projectId, { chatId = 'oc_reminder01', consultantId = 'felix' } = {}) {
  const accepted = acceptCommitment(db, consultantId, projectId, {
    goal: '两周内交付 5 名匹配候选人',
    action_title: '跟进客户反馈并确认面试转化',
    due_at: new Date(Date.parse(TEST_NOW) + 3 * 86400000).toISOString(),
    idempotency_key: `fixture:accept:${projectId}:${consultantId}`,
  });
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);
  db.prepare(`INSERT INTO project_launches
    (launch_id, consultant_id, project_id, idempotency_key, status, current_step, chat_id, chat_name,
     created_at, updated_at)
    VALUES (?,?,?,?, 'READY','DONE',?,?,?,?)`)
    .run(`launch-${projectId}-${consultantId}`, consultantId, projectId,
      `fixture:launch:${projectId}:${consultantId}`, chatId, '物外智趣 · App 产品设计师', OLD, OLD);
  backdateActivity(db, projectId);
  return { chatId };
}

/** 把该项目全部活动时间回拨（保证「静默」判定成立）。 */
function backdateActivity(db, projectId) {
  for (const [sql, ...args] of [
    ['UPDATE decision_events SET occurred_at=? WHERE project_id=?', OLD, projectId],
    ['UPDATE commitment_actions SET created_at=?, updated_at=? WHERE project_id=?', OLD, OLD, projectId],
    ['UPDATE job_outcomes SET observed_at=? WHERE project_id=?', OLD, projectId],
    ['UPDATE openmai_results SET started_at=?, finished_at=? WHERE project_id=?', OLD, OLD, projectId],
  ]) db.prepare(sql).run(...args);
}

test('collectProjectReminders：静默超阈值才候选，群消息算活动', () => {
  const { db, projectId } = fixture();
  const { chatId } = seedReminderProject(db, projectId);
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 1, '96h 无任何操作 → 候选');

  db.prepare(`INSERT INTO lark_messages (message_id, chat_id, message_type, text, mentions_json, create_time, received_at)
    VALUES ('m1', ?, 'text', '在吗', '[]', ?, ?)`).run(chatId, RECENT, RECENT);
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 0, '1h 前群里有消息 → 不候选');

  db.prepare('DELETE FROM lark_messages WHERE message_id=?').run('m1');
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 1, '删除消息后恢复候选');
});

test('collectProjectReminders：只提醒 ACCEPTED，且 7 天冷却内不重发', () => {
  const { db, projectId } = fixture();
  seedReminderProject(db, projectId);
  const { consultant_id } = collectProjectReminders(db, TEST_NOW)[0];
  db.prepare(`INSERT INTO push_log (push_id, consultant_id, kind, run_id, card_json, target, status, created_at)
    VALUES ('p1', ?, 'PROJECT_REMINDER', ?, '{}', 'oc_x', 'SENT', ?)`)
    .run(consultant_id, `proj:${projectId}:${reminderWeekKey(TEST_NOW)}`, RECENT);
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 0, '7 天内已提醒过 → 冷却');
  db.prepare("UPDATE push_log SET created_at=? WHERE push_id='p1'")
    .run(new Date(Date.parse(TEST_NOW) - 8 * 86400000).toISOString());
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 1, '8 天前提醒过 → 冷却已过');

  db.prepare("UPDATE decision_events SET next_state='COMPLETED' WHERE project_id=? AND event_type='ACCEPTED'")
    .run(projectId);
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 0, 'COMPLETED 项目不打扰');
});

test('collectProjectReminders：RELEASED / 无项目群不候选', () => {
  const { db, projectId } = fixture();
  seedReminderProject(db, projectId);
  db.prepare("UPDATE decision_events SET next_state='RELEASED' WHERE project_id=? AND event_type='ACCEPTED'")
    .run(projectId);
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 0, 'RELEASED 不打扰');
  db.prepare("UPDATE decision_events SET next_state='ACCEPTED' WHERE project_id=? AND event_type='ACCEPTED'")
    .run(projectId);
  db.prepare("UPDATE project_launches SET chat_id=NULL WHERE project_id=?").run(projectId);
  assert.equal(collectProjectReminders(db, TEST_NOW).length, 0, '没有项目群无法投递');
});

test('卡片：读上下文（目标/行动/截止）并带修正引导与工作台按钮', () => {
  const { db, projectId } = fixture();
  seedReminderProject(db, projectId);
  const ctx = collectProjectReminders(db, TEST_NOW)[0];
  const card = buildProjectReminderCard(ctx, { publicBaseUrl: 'https://app.ttcadvisory.com' });
  const text = JSON.stringify(card);
  assert.ok(text.includes('两周内交付 5 名匹配候选人'), '卡片带本轮目标');
  assert.ok(text.includes('跟进客户反馈并确认面试转化'), '卡片带当前行动');
  assert.ok(text.includes('直接在群里回复修正'), '带顾问自行修正引导');
  assert.ok(text.includes('打开职位工作台'), '带工作台深链按钮');
  assert.ok(inSendWindow(new Date('2026-09-10T03:00:00.000Z')), 'CST 11:00 在窗口');
  assert.equal(inSendWindow(new Date('2026-09-10T16:00:00.000Z')), false, 'CST 00:00 不在窗口');
});

test('remindProjectsOnce：窗口外跳过；窗口内幂等不重发', async () => {
  const { db, projectId } = fixture();
  seedReminderProject(db, projectId);
  const closed = await remindProjectsOnce(db, { at: new Date('2026-09-10T16:00:00.000Z'), send: false });
  assert.equal(closed.window, 'closed');
  assert.equal(closed.sent, 0);

  const at = new Date(TEST_NOW);
  const first = await remindProjectsOnce(db, { at, send: false, publicBaseUrl: 'https://app.ttcadvisory.com' });
  assert.equal(first.candidates, 1, '首轮命中 1 个候选');
  assert.equal(first.sent, 0, 'PREVIEW 不计入发送数');
  const second = await remindProjectsOnce(db, { at, send: false, publicBaseUrl: 'https://app.ttcadvisory.com' });
  assert.equal(second.candidates, 1, 'PREVIEW 不算冷却命中，候选仍在');
  assert.equal(second.sent, 0, '同 run_id 重复扫描不重发（幂等）');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM push_log WHERE kind='PROJECT_REMINDER'").get().n, 1);
});

test('remindProjectsOnce：发送失败落 FAILED，下一轮可重试成功', async () => {
  const { db, projectId } = fixture();
  seedReminderProject(db, projectId);
  const at = new Date(TEST_NOW);
  const bad = await remindProjectsOnce(db, { at, send: true, publicBaseUrl: 'https://app.ttcadvisory.com',
    sendImpl: async () => { throw new Error('FEISHU_DOWN'); } });
  assert.equal(bad.failed, 1, '发送失败计入 failed');
  assert.equal(db.prepare("SELECT status FROM push_log WHERE kind='PROJECT_REMINDER'").get().status, 'FAILED');
  const good = await remindProjectsOnce(db, { at, send: true, publicBaseUrl: 'https://app.ttcadvisory.com',
    sendImpl: async () => ({ message_id: 'om_ok' }) });
  assert.equal(good.sent, 1, '下一轮重试成功（同一 push_id 更新为 SENT）');
  assert.equal(db.prepare("SELECT status FROM push_log WHERE kind='PROJECT_REMINDER'").get().status, 'SENT');
});
