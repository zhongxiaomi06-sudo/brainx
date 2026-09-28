/** bridge-producer.js — 群消息 → 账本的生产者（2026-09-03；2026-09-23 specs/019 US2 瘦身）。
 *
 * 角色：把 bridge 已拉取的群消息喂给 L1 事件账本（workflow_event_log +
 * lark_messages 原文表）——零新增凭据（复用 bridge 的顾问用户令牌通道，
 * 不落 DENY 事件、正文 PII 不进账本 payload）。
 *
 * specs/019 US2 起：本模块只生产，不消费。提炼（job-extract / judgment-extract）
 * 由 dispatcher 按注册表异步派发（src/hub/dispatcher.js），LLM 预抽取与
 * schema 回退补偿收进消费者自身的 prepare/apply——此前生产者内联调用消费者 +
 * presetFields 注入 + 双份 try/catch 的形态已删除。
 *
 * 幂等两层：lark_messages 主键去重 → workflow_event_log idem_key 唯一；
 * 消费幂等由 consumeOnce（processed_events）在 dispatcher 侧兜底。
 */
import { uuid, now } from '../db.js';
import { appendEvent } from '../hub/event-log.js';

const INSERT_MSG_SQL = `INSERT OR IGNORE INTO lark_messages
  (message_id, chat_id, message_type, text, mentions_json, create_time, received_at)
  VALUES (?,?,?,?,?,?,?)`;

/** Bridge 既可能传飞书毫秒/秒时间戳，也可能传已格式化的上海本地时间。 */
export function normalizeCreateTime(value, fallback = now()) {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).trim();
  const numeric = Number(raw);
  const millis = Number.isFinite(numeric) && numeric > 0
    ? (Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}+08:00`);
  if (!Number.isFinite(millis)) return fallback;
  const parsed = new Date(millis);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

/** 单条消息：落原文表 → 追加账本。返回 {produced, event_id?, reason?}。 */
export async function produceOne(db, { message_id, chat_id, msg_type = 'text', text = '',
                                 sender = {}, mentions = [], create_time }) {
  const createIso = normalizeCreateTime(create_time);
  db.prepare(INSERT_MSG_SQL).run(message_id, chat_id, msg_type, String(text || ''),
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
  return { produced: !ev.deduplicated, event_id: ev.event.event_id };
}

/** 一批 bridge 消息（与 ingestMessages 同批）：逐条生产，返回计数。
 *  提炼由 dispatcher 异步完成，本函数不再返回 drafts。 */
export async function produceAndExtract(db, chat_id, messages) {
  let produced = 0, skipped = 0;
  for (const m of messages || []) {
    if (!m?.message_id) { skipped++; continue; }
    const text = typeof m.content === 'string' ? m.content
      : (m.content?.text ?? JSON.stringify(m.content ?? ''));
    const r = await produceOne(db, { message_id: m.message_id, chat_id, msg_type: m.msg_type || 'text',
                               text, sender: m.sender, mentions: m.mentions,
                               create_time: m.create_time });
    if (r.produced) produced++;
    else skipped++;
  }
  return { produced, skipped };
}

/** 回填：从 job_messages 表（bridge 已落库的历史消息）补进提炼闭环。
 * 用途：dispatcher 上线前的存量消息补课；按 chat_id+天数窗口，幂等安全。 */
export async function backfillFromJobMessages(db, { chat_id = null, days = 7, limit = 500 } = {}) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const rows = db.prepare(`SELECT message_id, chat_id, msg_type, text, sent_at
    FROM job_messages WHERE ingested_at >= ? ${chat_id ? 'AND chat_id=?' : ''}
    ORDER BY ingested_at ASC LIMIT ?`).all(...(chat_id ? [cutoff, chat_id, limit] : [cutoff, limit]));
  let produced = 0;
  for (const r of rows) {
    const out = await produceOne(db, { message_id: r.message_id, chat_id: r.chat_id,
                                 msg_type: r.msg_type, text: r.text, create_time: Date.parse(r.sent_at) || null });
    if (out.produced) produced++;
  }
  return { scanned: rows.length, produced };
}
