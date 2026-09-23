#!/usr/bin/env node
/** brainx-dispatcher — specs/019 US2 事件调度常驻进程。
 *  按注册表（src/hub/dispatcher.js defaultConsumers）把账本未消费事件派发给
 *  各消费者（两段式：prepare 异步 IO 在事务外，apply 写库在 consumeOnce 事务内）。
 *  失败重试/死信见 consumer_failures（0052）。生产只跑一个实例。 */
import '../src/env.js';
import { hostname } from 'node:os';
import { openDb } from '../src/db.js';
import { dispatchOnce, defaultConsumers } from '../src/hub/dispatcher.js';

const db = openDb();
const consumers = defaultConsumers();
const workerId = `${hostname()}:${process.pid}`;
const INTERVAL_MS = Number(process.env.BRAINX_DISPATCHER_INTERVAL_MS || 2_000);
let stopping = false;
process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

console.log(`[dispatcher] ${workerId} consumers=[${consumers.map((c) => c.name).join(',')}] interval=${INTERVAL_MS}ms`);
while (!stopping) {
  try {
    const stats = await dispatchOnce(db, consumers);
    if (stats.dispatched || stats.failed) {
      console.log(`[dispatcher] dispatched=${stats.dispatched} failed=${stats.failed}`, JSON.stringify(stats.perConsumer));
    }
  } catch (error) {
    // 调度循环自身不崩：单轮异常记日志，下一轮继续（消费者级故障已在 consumer_failures 记账）
    console.error(`[dispatcher] round failed: ${String(error?.message || error).slice(0, 300)}`);
  }
  await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
}
db.close();
