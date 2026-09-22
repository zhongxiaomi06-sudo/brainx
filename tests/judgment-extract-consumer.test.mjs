/** judgment-extract-consumer.test.mjs — 判断抽取消费者挂账本端到端（specs/016）。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 模式复刻 job-extract-consumer.test.mjs：consumeOnce('judgment-extract') 幂等，
 * 与 job-extract 是同一事件上的独立消费者；无可抽取判断时 skip（不落空草稿）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';
import { consumeJudgmentExtract, CONSUMER_NAME } from '../src/judgment-extract/index.js';
import { consumeJobExtract } from '../src/job-extract/index.js';
import { produceOne } from '../src/job-extract/bridge-producer.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-j1-')), 'test.db'));

function seedChat(db, chatId = 'oc_g') {
  registerChatContext(db, { chat_id: chatId, bot_mode: 'ALL' });
}

function feedMessage(db, text, chatId = 'oc_g', messageId = 'om_j001') {
  const r = processLarkEvent(db, {
    message_id: messageId, chat_id: chatId, open_id: 'ou_user_1',
    mentions: [], message_type: 'text',
    create_time: '2026-09-22T10:00:00+08:00', body: { text },
  });
  assert.ok(['queued', 'duplicate'].includes(r.action), `网关应放行消息: ${JSON.stringify(r)}`);
  const row = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key = ?').get(`lark:message:${messageId}`);
  return row.event_id;
}

test('判断消息 → 抽出草稿，字段带 evidence，source=rules，status=pending', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '星曜科技说：不接受异地候选人，必须base上海');
  const r = consumeJudgmentExtract(db, eventId);
  assert.equal(r.ok, true);
  assert.equal(r.result.action, 'extracted');
  const d = db.prepare('SELECT * FROM judgment_drafts WHERE draft_id = ?').get(r.result.draft_id);
  assert.ok(d, '草稿应落 staging 表');
  assert.equal(d.source, 'rules');
  assert.equal(d.status, 'pending');
  assert.equal(d.subject_type, 'CLIENT_COMPANY');
  assert.equal(d.subject_ref, '星曜科技');
  assert.equal(d.kind, 'CONSTRAINT');
  assert.ok(d.statement.includes('不接受异地候选人'));
  assert.ok(d.statement_evidence.length > 0, '无 evidence 不落库');
  assert.equal(d.event_id, eventId);
});

test('幂等：同 event_id 重放不产生第二条草稿（consumeOnce 兜底）', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '星曜科技说：不接受异地候选人');
  const r1 = consumeJudgmentExtract(db, eventId);
  const r2 = consumeJudgmentExtract(db, eventId);
  assert.equal(r1.result.action, 'extracted');
  assert.equal(r2.skipped, true, '重放应被幂等标记吃掉');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_drafts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events WHERE consumer_name=? AND event_id=?')
    .get(CONSUMER_NAME, eventId).n, 1);
});

test('与 job-extract 互不干扰：同一事件两个消费者各自幂等', () => {
  const db = newDb();
  seedChat(db);
  const eventId = feedMessage(db, '星曜科技说：不接受异地候选人，急招后端工程师 HC 2');
  const j = consumeJudgmentExtract(db, eventId);
  const f = consumeJobExtract(db, eventId);
  assert.equal(j.result.action, 'extracted');
  assert.equal(f.result.action, 'extracted');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_drafts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts_drafts').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processed_events WHERE event_id=?').get(eventId).n, 2);
});

test('无关消息 → skip irrelevant；有关键词但无显式判断 → skip no_judgment', () => {
  const db = newDb();
  seedChat(db);
  const e1 = feedMessage(db, '明天团建记得带伞', 'oc_g', 'om_noise1');
  const r1 = consumeJudgmentExtract(db, e1);
  assert.equal(r1.result.action, 'skip');
  assert.equal(r1.result.reason, 'irrelevant');

  const e2 = feedMessage(db, '这个候选人因为最近跳槽太频繁，我们再看看', 'oc_g', 'om_noise2');
  const r2 = consumeJudgmentExtract(db, e2);
  assert.equal(r2.result.action, 'skip');
  assert.equal(r2.result.reason, 'no_judgment', '判断域不落空草稿');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_drafts').get().n, 0);
});

test('非 lark.message_received 事件（DENY）→ skip 不抽', () => {
  const db = newDb();
  processLarkEvent(db, {
    message_id: 'om_denied', chat_id: 'oc_unknown', open_id: 'ou_user_1',
    mentions: [], message_type: 'text', create_time: '2026-09-22T10:00:00+08:00',
    body: { text: '客户说不接受异地' },
  });
  const denied = db.prepare("SELECT event_id FROM workflow_event_log WHERE event_type='lark.ignored'").get();
  const r = consumeJudgmentExtract(db, denied.event_id);
  assert.equal(r.result.action, 'skip');
  assert.equal(r.result.reason, 'not_message_event');
});

test('bridge-producer 全链：消息同时产出职位草稿与判断草稿，重放幂等', async () => {
  const db = newDb();
  const text = '星曜科技说不接受异地，急招后端工程师 HC 2，base 上海';
  const r1 = await produceOne(db, { message_id: 'om_jp_1', chat_id: 'oc_x', text, create_time: Date.now() });
  assert.equal(r1.produced, true);
  assert.ok(r1.judgment_draft, '判断域应产出草稿');
  assert.ok(r1.draft, '职位事实域应产出草稿');
  const again = await produceOne(db, { message_id: 'om_jp_1', chat_id: 'oc_x', text: '重复' });
  assert.equal(again.produced, false, 'idem_key 去重');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_drafts').get().n, 1);
});
