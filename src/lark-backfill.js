/** lark-backfill — 用户身份 lark-cli 历史消息回填（specs/022 信号层第二批）。
 *
 * 背景：lark_messages 由网关事件驱动写入（bot 必须在群内才有事件流）。
 * bot 不在群、但用户身份可见的客户群（第二批 24 个），用 lark-cli
 * `im +chat-messages-list --as user --page-all` 拉历史后经本模块落库。
 *
 * 语义约定：
 *  - origin='backfill'，received_at=回填时刻——与网关实时事件区分，
 *    勿把 backfill 行用于送达时效类指标；
 *  - create_time 保留飞书侧消息产生时间（分钟精度，按 +08:00 解析转 UTC ISO）；
 *  - message_id 主键幂等：INSERT OR IGNORE，重复回填不增行；
 *  - deleted=true 的条目跳过（已撤回消息不入审计面）。
 */
import { now } from './db.js';

/** "2026-07-29 18:47"（飞书工作区时区 +08:00，分钟精度）→ UTC ISO 字符串。 */
export function localToUtcIso(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec] = m;
  const dt = new Date(`${y}-${mo}-${d}T${h}:${mi}:${sec ?? '00'}+08:00`);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}

/** 把 lark-cli message 条目映射为 lark_messages 行；非法条目返回 null。 */
export function mapLarkCliMessage(m) {
  if (!m || m.deleted === true) return null;
  if (typeof m.message_id !== 'string' || !m.message_id.startsWith('om_')) return null;
  if (typeof m.chat_id !== 'string' || !m.chat_id) return null;
  const create_time = localToUtcIso(m.create_time);
  if (!create_time) return null;
  const mentions = Array.isArray(m.mentions)
    ? m.mentions.map((x) => (x && typeof x.id === 'string' ? x.id : null)).filter(Boolean)
    : [];
  return {
    message_id: m.message_id,
    chat_id: m.chat_id,
    message_type: typeof m.msg_type === 'string' ? m.msg_type : null,
    text: typeof m.content === 'string' ? m.content : null,
    mentions_json: mentions.length ? JSON.stringify(mentions) : null,
    create_time,
    received_at: now(),
  };
}

/** 解析 lark-cli +chat-messages-list 的 JSON 输出，返回 messages 数组。 */
export function parseLarkCliOutput(raw) {
  const start = raw.indexOf('{');
  if (start === -1) throw new Error('lark-cli 输出中找不到 JSON 对象');
  const parsed = JSON.parse(raw.slice(start));
  if (parsed?.ok !== true) throw new Error(`lark-cli 调用未成功：ok=${parsed?.ok}`);
  const msgs = parsed?.data?.messages;
  if (!Array.isArray(msgs)) throw new Error('lark-cli 输出缺少 data.messages 数组');
  return msgs;
}

const INSERT_SQL = `
INSERT OR IGNORE INTO lark_messages
  (message_id, chat_id, message_type, text, mentions_json, create_time, received_at, origin)
VALUES (?, ?, ?, ?, ?, ?, ?, 'backfill')`;

/** 把一批映射好的行写入 lark_messages（幂等）。返回 {total, inserted}。 */
export function backfillRows(db, rows) {
  const stmt = db.prepare(INSERT_SQL);
  let inserted = 0;
  for (const r of rows) {
    const res = stmt.run(r.message_id, r.chat_id, r.message_type, r.text, r.mentions_json, r.create_time, r.received_at);
    inserted += res.changes;
  }
  return { total: rows.length, inserted };
}
