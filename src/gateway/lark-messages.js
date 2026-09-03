/** lark-messages.js — 网关通过事件时持久化消息正文（E1 提炼层输入）。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4；
 * 规格 002 data-model 留下的「消息正文落库后续规格决定」由此补齐：
 * 账本 payload 仍不含正文 PII（FR-006 不变），evidence_refs 指向的
 * lark_messages 表由本模块在事件通过时落行（INSERT OR IGNORE 幂等）。
 * DENY 事件不落正文——被拒消息只留审计元数据。
 */
import { now } from '../db.js';

const INSERT_SQL = `
  INSERT OR IGNORE INTO lark_messages
    (message_id, chat_id, message_type, text, mentions_json, create_time, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

/**
 * 落一条消息正文（幂等：同 message_id 重投不覆盖）。
 * @param {object} db
 * @param {object} evt 解密后标准消息事件（{message_id,chat_id,message_type,body,mentions,create_time}）
 */
export function persistLarkMessage(db, evt) {
  db.prepare(INSERT_SQL).run(
    evt.message_id,
    evt.chat_id,
    evt.message_type ?? null,
    evt.body?.text ?? evt.text ?? null,
    JSON.stringify(evt.mentions ?? []),
    evt.create_time ?? now(),
    now(),
  );
}
