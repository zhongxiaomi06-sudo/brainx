/** chat-contexts.js — Step 1 飞书群登记表读写（运营脚本预填，事件路径只读）。
 *
 * 权威契约: specs/002-step1-lark-gateway/spec.md FR-001/FR-005；
 * registerChatContext 用 upsert（同 chat_id 刷新 bot_mode/notes，不改 enabled）。
 */
import { now } from '../db.js';

const SELECT_SQL = 'SELECT * FROM chat_contexts WHERE chat_id = ?';
const UPSERT_SQL = `
  INSERT INTO chat_contexts (chat_id, enabled, bot_mode, default_deny_reason, registered_at, updated_at, notes)
  VALUES (?, 1, ?, NULL, ?, ?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET bot_mode = excluded.bot_mode, notes = excluded.notes, updated_at = excluded.updated_at`;
const SET_ENABLED_SQL = 'UPDATE chat_contexts SET enabled = ?, updated_at = ? WHERE chat_id = ?';
const LIST_SQL = 'SELECT * FROM chat_contexts ORDER BY registered_at';

export function registerChatContext(db, { chat_id, bot_mode = 'MENTION_ONLY', notes = null }) {
  const ts = now();
  db.prepare(UPSERT_SQL).run(chat_id, bot_mode, ts, ts, notes);
  return { ok: true };
}

export function setChatEnabled(db, chat_id, enabled) {
  const res = db.prepare(SET_ENABLED_SQL).run(enabled ? 1 : 0, now(), chat_id);
  if (res.changes === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

export function getChatContext(db, chat_id) {
  return db.prepare(SELECT_SQL).get(chat_id) ?? null;
}

export function listChatContexts(db) {
  return db.prepare(LIST_SQL).all();
}
