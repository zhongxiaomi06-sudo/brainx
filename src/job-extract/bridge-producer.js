/** bridge-producer.js — 群消息 → E3 提炼闭环的常驻生产者（2026-09-03）。
 *
 * 角色：把 bridge 已拉取的群消息同时喂给 L1 事件账本（workflow_event_log +
 * lark_messages 原文表），并立刻交给 job-extract 消费者抽 draft——
 * 补齐「群消息自动形成职位事实」缺失的常驻 handler，零新增凭据
 * （复用 bridge 的顾问用户令牌通道，不落 DENY 事件、正文 PII 不进账本 payload）。
 *
 * 幂等三层：lark_messages 主键去重 → workflow_event_log idem_key 唯一 →
 * consumeOnce('job-extract') 消费幂等。重复喂同一条消息全部安全短路。
 */
import { uuid, now } from '../db.js';
import { appendEvent } from '../hub/event-log.js';
import { consumeJobExtract } from './index.js';

const INSERT_MSG_SQL = `INSERT OR IGNORE INTO lark_messages
  (message_id, chat_id, message_type, text, mentions_json, create_time, received_at)
  VALUES (?,?,?,?,?,?,?)`;

/** 单条消息：落原文表 → 追加账本 → 抽 draft。返回 {produced, draft_id?}。 */
export function produceOne(db, { message_id, chat_id, msg_type = 'text', text = '',
                                 sender = {}, mentions = [], create_time }) {
  const createIso = create_time ? new Date(Number(create_time)).toISOString() : now();
  const wrote = db.prepare(INSERT_MSG_SQL).run(message_id, chat_id, msg_type, String(text || ''),
                                 JSON.stringify(mentions || []), createIso, now());
  const ev = appendEvent(db, {
    event_id: uuid(), idem_key: `lark.message_received:${message_id}`,
    event_type: 'lark.message_received', actor: `bridge:${sender?.id || 'unknown'}`,
    occurred_at: createIso,
    payload: { chat_id, message_id }, // 正文 PII 不进账本（FR-006），引用走 lark_messages
    evidence_refs: [{ table: 'lark_messages', id: message_id }],
    schema_version: 1,
  });
  if (!ev.ok) return { produced: false, reason: ev.reason };
  const consumed = consumeJobExtract(db, ev.event.event_id);
  return { produced: !ev.deduplicated, event_id: ev.event.event_id,
           draft: consumed?.result?.draft_id || null, action: consumed?.result?.action || null };
}

/** 一批 bridge 消息（与 ingestMessages 同批）：逐条生产+抽取，返回计数。 */
export function produceAndExtract(db, chat_id, messages) {
  let produced = 0, drafts = 0, skipped = 0;
  for (const m of messages || []) {
    if (!m?.message_id) { skipped++; continue; }
    const text = typeof m.content === 'string' ? m.content
      : (m.content?.text ?? JSON.stringify(m.content ?? ''));
    const r = produceOne(db, { message_id: m.message_id, chat_id, msg_type: m.msg_type || 'text',
                               text, sender: m.sender, mentions: m.mentions,
                               create_time: m.create_time });
    if (r.produced) produced++;
    else skipped++;
    if (r.draft) drafts++;
  }
  return { produced, drafts, skipped };
}

/** 回填：从 job_messages 表（bridge 已落库的历史消息）补进提炼闭环。
 * 用途：handler 上线前的存量消息补课；按 chat_id+天数窗口，幂等安全。 */
export function backfillFromJobMessages(db, { chat_id = null, days = 7, limit = 500 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`SELECT message_id, chat_id, msg_type, text, sent_at
    FROM job_messages WHERE ingested_at >= ? ${chat_id ? 'AND chat_id=?' : ''}
    ORDER BY ingested_at ASC LIMIT ?`).all(...(chat_id ? [cutoff, chat_id, limit] : [cutoff, limit]));
  let produced = 0, drafts = 0;
  for (const r of rows) {
    const out = produceOne(db, { message_id: r.message_id, chat_id: r.chat_id,
                                 msg_type: r.msg_type, text: r.text, create_time: Date.parse(r.sent_at) || null });
    if (out.produced) produced++;
    if (out.draft) drafts++;
  }
  return { scanned: rows.length, produced, drafts };
}
