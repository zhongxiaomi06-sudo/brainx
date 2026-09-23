/** dispatcher.js — 事件 → 消费者调度层（specs/019 US2）。
 *
 * 权威契约: specs/019-hub-event-backbone/contracts/event-types.md（消费者注册契约）。
 *
 * 解决的断点：账本此前只写不读——消费者靠 bridge 生产者手工同步调用，错误散在各处
 * try/catch 静默。本模块把「事件 × 消费者」的未消费集合扫描 + 派发 + 重试/死信
 * 收拢到一处：消费者注册即生效（不改生产者），失败按 maxRetries 重试后进
 * consumer_failures 死信（0052），replayConsumerFailure 可重放。
 *
 * 派发语义：每条事件对每个消费者恰好一次（consumeOnceAsync 两段式：prepare 异步 IO
 * 在事务外，apply 同步写库在 consumeOnce 事务内）。单消费者异常 try/catch 隔离，
 * 不影响其他消费者与消息落账。
 *
 * 部署：单实例运行（bin/brainx-dispatcher.mjs 常驻循环）。多实例并发安全底线由
 * consumeOnce 的 BEGIN IMMEDIATE 二次确认兜底，但 prepare（LLM 调用）可能重复付费——
 * 生产只跑一个 dispatcher 进程。
 */
import { now } from '../db.js';
import { consumeOnceAsync } from './consumer.js';
import { jobExtractConsumer } from '../job-extract/index.js';
import { judgmentExtractConsumer } from '../judgment-extract/index.js';

/** 默认注册表：群消息提炼双域。新增消费者 = 在此加一行注册项（不改生产者）。 */
export function defaultConsumers() {
  return [jobExtractConsumer, judgmentExtractConsumer];
}

function scanUnconsumed(db, consumer, limit) {
  const types = Array.isArray(consumer.eventTypes) ? consumer.eventTypes : [];
  const typeFilter = types.length
    ? `AND e.event_type IN (${types.map(() => '?').join(',')})`
    : '';
  return db.prepare(`
    SELECT e.event_id FROM workflow_event_log e
    WHERE NOT EXISTS (SELECT 1 FROM processed_events p
                      WHERE p.event_id = e.event_id AND p.consumer_name = ?)
      AND NOT EXISTS (SELECT 1 FROM consumer_failures f
                      WHERE f.event_id = e.event_id AND f.consumer_name = ?
                        AND f.resolved_at IS NULL AND f.attempts >= ?)
      ${typeFilter}
    ORDER BY e.occurred_at, e.event_id
    LIMIT ?`).all(consumer.name, consumer.name, consumer.maxRetries ?? 3, ...types, limit)
    .map((row) => row.event_id);
}

const UPSERT_FAILURE_SQL = `
  INSERT INTO consumer_failures
    (event_id, consumer_name, attempts, last_error, first_failed_at, last_failed_at)
  VALUES (?, ?, 1, ?, ?, ?)
  ON CONFLICT(event_id, consumer_name) DO UPDATE SET
    attempts = attempts + 1,
    last_error = excluded.last_error,
    last_failed_at = excluded.last_failed_at,
    resolved_at = NULL`;

function recordFailure(db, eventId, consumer, error) {
  const ts = now();
  db.prepare(UPSERT_FAILURE_SQL).run(
    eventId, consumer.name, String(error?.message || error).slice(0, 500), ts, ts);
}

/** 重放死信：清 resolved 标记后事件回到可派发集合（重放成功由 consumeOnce 标记）。 */
export function replayConsumerFailure(db, eventId, consumerName) {
  const out = db.prepare(`UPDATE consumer_failures SET resolved_at=?
    WHERE event_id=? AND consumer_name=? AND resolved_at IS NULL`)
    .run(now(), eventId, consumerName);
  return out.changes > 0;
}

/**
 * 一轮派发：对每个注册消费者扫描未消费事件并逐条消费。
 * @returns {{dispatched:number, failed:number, perConsumer:Object}}
 */
export async function dispatchOnce(db, consumers, { limit = 100, deps = {} } = {}) {
  const stats = { dispatched: 0, failed: 0, perConsumer: {} };
  for (const consumer of consumers) {
    const eventIds = scanUnconsumed(db, consumer, limit);
    let ok = 0;
    let failed = 0;
    for (const eventId of eventIds) {
      try {
        const r = await consumeOnceAsync(db, eventId, consumer.name, consumer, { db, ...deps });
        if (!r.ok) throw new Error(`CONSUME_REFUSED:${r.reason}`);
        if (!r.skipped) ok += 1;
      } catch (error) {
        failed += 1;
        recordFailure(db, eventId, consumer, error);
      }
    }
    stats.perConsumer[consumer.name] = { dispatched: ok, failed };
    stats.dispatched += ok;
    stats.failed += failed;
  }
  return stats;
}
