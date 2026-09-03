/** consumer.js — Step 0 消费者幂等事务模板（consumeOnce）。
 *
 * 权威契约: specs/001-step0-event-ledger/spec.md FR-002；
 * 业务动作 fn(db) 与 processed_events 标记在同一事务内提交：
 * 崩溃（fn 抛错）→ 整体回滚，重放后与"恰好一次"语义一致；已标记则直接跳过。
 */
import { now } from '../db.js';

const MARK_SQL =
  'INSERT INTO processed_events (event_id, consumer_name, processed_at) VALUES (?, ?, ?)';
const CHECK_SQL =
  'SELECT 1 AS done FROM processed_events WHERE event_id = ? AND consumer_name = ?';

/**
 * 消费事件至多一次。fn(db) 在业务事务内执行，抛错即整体回滚并向上传播。
 * 返回 {ok:true, skipped:boolean}。
 */
export function consumeOnce(db, eventId, consumerName, fn) {
  if (db.prepare(CHECK_SQL).get(eventId, consumerName)) return { ok: true, skipped: true };
  db.exec('BEGIN IMMEDIATE'); // 事务内二次确认，防跨连接竞态
  try {
    if (db.prepare(CHECK_SQL).get(eventId, consumerName)) {
      db.exec('ROLLBACK');
      return { ok: true, skipped: true };
    }
    fn(db);
    db.prepare(MARK_SQL).run(eventId, consumerName, now());
    db.exec('COMMIT');
    return { ok: true, skipped: false };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已回滚或无活动事务 */
    }
    throw err;
  }
}
