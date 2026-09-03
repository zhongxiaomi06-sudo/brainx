/** job-extract-consumer.test.mjs — E1 提炼层挂账本消费者端到端（测试先行）。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4；
 * 关键架构：提炼层是 L1 事件账本的一个消费者（consumeOnce('job-extract')），
 * 幂等由 Step 0 兜底；消息正文由网关落 lark_messages（规格 002 遗留决定由本步补齐）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';
import { consumeJobExtract, CONSUMER_NAME } from '../src/job-extract/index.js';
import { produceOne, backfillFromJobMessages } from '../src/job-extract/bridge-producer.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-e1-')), 'test.db'));

function seedChat(db, chatId = 'oc_offer_group') {
  registerChatContext(db, { chat_id: chatId, bot_mode: 'ALL', notes: 'Offer-WD-MY-从容地-UIUX' });
}

/** 经真实网关入口落事件（正文随行落 lark_messages），返回 event_id。 */
function feedMessage(db, text, chatId = 'oc_offer_group', messageId = 'om_001') {
  const r = processLarkEvent(db, {
    message_id: messageId,
    chat_id: chatId,
    open_id: 'ou_user_1',
    mentions: [],
    message_type: 'text',
    create_time: '2026-09-02T10:00:00+08:00',
    body: { text },
  });
  assert.ok(['queued', 'duplicate'].includes(r.action), `网关应放行消息: ${JSON.stringify(r)}`);
  const row = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key = ?').get(`lark:message:${messageId}`);
  return row.event_id;
}

test('E1: 网关通过事件时把消息正文落 lark_messages（evidence 引用目标真实存在）', () => {
  const db = newDb();
  seedChat(db);
  feedMessage(db, '这个岗位急招，HC 2 人');
  const msg = db.prepare('SELECT * FROM lark_messages WHERE message_id = ?').get('om_001');
  assert.ok(msg, 'lark_messages 应有行（此前 evidence_refs 指向不存在的表）');
  assert.equal(msg.text, '这个岗位急招，HC 2 人');
  assert.equal(msg.chat_id, 'oc_offer_group');
});

test('E1: 同一 message_id 重复投递，lark_messages 不重复（INSERT OR IGNORE 幂等）', () => {
  const db = newDb();
  seedChat(db);
  feedMessage(db, '第一遍', 'oc_offer_group', 'om_dup');
  feedMessage(db, '第一遍', 'oc_offer_group', 'om_dup');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lark_messages WHERE message_id=?').get('om_dup').n, 1);
});

test('E1: 职位相关消息 → 抽出草稿，字段带 evidence，source=rules，status=pending', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '星曜科技急招后端工程师，HC 2，base 上海');
  const r = consumeJobExtract(db, eventId);
  assert.equal(r.ok, true);
  assert.equal(r.result.action, 'extracted');
  const d = db.prepare('SELECT * FROM job_facts_drafts WHERE draft_id = ?').get(r.result.draft_id);
  assert.ok(d, '草稿应落 staging 表');
  assert.equal(d.source, 'rules');
  assert.equal(d.status, 'pending');
  assert.equal(d.company, '星曜科技');
  assert.equal(d.role, '后端工程师');
  assert.equal(d.hc, 2);
  assert.equal(d.city, '上海');
  assert.ok(d.company_evidence.includes('星曜科技'));
  assert.equal(d.active_state, 'OPEN');
  assert.equal(d.event_id, eventId);
  const raw = JSON.parse(d.raw_json);
  assert.equal(raw.company.evidence, d.company_evidence, 'raw_json 存档与列一致');
});

test('E1/SC: 幂等——同 event_id 重放不产生第二条草稿（consumeOnce 兜底）', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '星曜科技急招后端工程师，HC 2');
  const r1 = consumeJobExtract(db, eventId);
  const r2 = consumeJobExtract(db, eventId);
  assert.equal(r1.result.action, 'extracted');
  assert.equal(r2.skipped, true, '重放应被幂等标记吃掉');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM processed_events WHERE consumer_name=? AND event_id=?").get(CONSUMER_NAME, eventId).n, 1);
});

test('E1: 无关消息 → skip_irrelevant（消费标记照落，不产生草稿）', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '明天团建记得带伞', 'oc_offer_group', 'om_noise');
  const r = consumeJobExtract(db, eventId);
  assert.equal(r.result.action, 'skip');
  assert.equal(r.result.reason, 'irrelevant');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events WHERE event_id=?').get(eventId).n, 1);
});

test('E1: 非 lark.message_received 事件（如 DENY）→ skip 不抽', () => {
  const db = newDb();
  seedChat(db);
  // 未登记群 → DENY 事件
  processLarkEvent(db, {
    message_id: 'om_denied', chat_id: 'oc_unknown', open_id: 'ou_user_1',
    mentions: [], message_type: 'text', create_time: '2026-09-02T10:00:00+08:00',
    body: { text: '急招 HC 2' },
  });
  const denied = db.prepare("SELECT event_id FROM workflow_event_log WHERE event_type='lark.ignored'").get();
  const r = consumeJobExtract(db, denied.event_id);
  assert.equal(r.result.action, 'skip');
  assert.equal(r.result.reason, 'not_message_event');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 0);
});

test('E1: 正文缺失（网关旧事件/异常）→ skip message_text_missing，不编造草稿', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '急招', 'oc_offer_group', 'om_missing');
  db.prepare('DELETE FROM lark_messages WHERE message_id=?').run('om_missing'); // 模拟旧事件无正文
  const r = consumeJobExtract(db, eventId);
  assert.equal(r.result.action, 'skip');
  assert.equal(r.result.reason, 'message_text_missing');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 0);
});

test('bridge-producer：消息→账本→draft 全链 + 三层幂等', () => {
  const db = newDb();
  const r1 = produceOne(db, { message_id: 'om_prod_1', chat_id: 'oc_x',
    text: '示例客户招高级数据产品经理 2 名，base 上海', create_time: Date.now() });
  assert.equal(r1.produced, true);
  const again = produceOne(db, { message_id: 'om_prod_1', chat_id: 'oc_x', text: '重复' });
  assert.equal(again.produced, false, 'idem_key 去重');
  const ledger = db.prepare('SELECT COUNT(*) n FROM workflow_event_log').get().n;
  const originals = db.prepare('SELECT COUNT(*) n FROM lark_messages').get().n;
  assert.ok(ledger >= 1 && originals >= 1);
  // 账本 payload 不含正文 PII（FR-006）
  const payloads = db.prepare('SELECT payload FROM workflow_event_log').all();
  for (const row of payloads) assert.doesNotMatch(row.payload, /高级数据产品经理/);
});

test('backfill：从 job_messages 存量回填幂等安全', () => {
  const db = newDb();
  db.prepare(`INSERT INTO job_messages (message_id, chat_id, sender_name, msg_type, text, sent_at, matched_project_id, ingested_at)
    VALUES ('om_bf_1','oc_x','tester','text','沐仞科技招 HR 专员 1 名，base 上海',datetime('now'),NULL,datetime('now'))`).run();
  const out = backfillFromJobMessages(db, { days: 1 });
  assert.ok(out.scanned >= 1 && out.produced >= 1);
  const again = backfillFromJobMessages(db, { days: 1 });
  assert.equal(again.produced, 0, '重复回填全部幂等短路');
});