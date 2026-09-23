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

/** 两段式异步消费（specs/019 US2，research.md 决策 2）：
 *  prepare（可选，异步 IO，如 LLM）在事务外执行；apply（同步写库）仍由 consumeOnce
 *  包裹进同一事务。恰好一次语义不破：已消费直接短路（不调 prepare，省外部调用）；
 *  prepare 抛错则 apply 不执行、无任何业务写入（错误由调用方按重试/死信处理）。
 *  consumer 形状：{ prepare?: (event, deps) => Promise<any>, apply: (db, event, prepared) => any }。
 *  @returns {{ok:true, skipped:boolean, result?:any} | {ok:false, reason}} */
export async function consumeOnceAsync(db, eventId, consumerName, consumer = {}, deps = {}) {
  if (db.prepare(CHECK_SQL).get(eventId, consumerName)) return { ok: true, skipped: true };
  const event = db.prepare('SELECT * FROM workflow_event_log WHERE event_id = ?').get(eventId);
  if (!event) return { ok: false, reason: 'event_not_found' };
  // 消费者拿到的是可用形态：payload/evidence_refs 解析为对象（账本存的是 JSON 串）
  const view = {
    ...event,
    payload: JSON.parse(event.payload ?? '{}'),
    evidence_refs: JSON.parse(event.evidence_refs ?? '[]'),
  };
  const prepared = consumer.prepare ? await consumer.prepare(view, deps) : undefined;
  let result;
  const r = consumeOnce(db, eventId, consumerName, (d) => {
    result = consumer.apply ? consumer.apply(d, view, prepared) : undefined;
  });
  return { ...r, result };
}
