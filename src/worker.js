#!/usr/bin/env node
/** worker.js — Brain X 批处理进程（2026-08-28 进程拆分 A 方案）。
 *
 * 职责：bridge 常驻同步（TTC/消息）+ 自动推荐 + 定时推卡。所有 setInterval
 * 批处理集中在这里，API 主进程（src/server.js）只跑 HTTP/SSE，永不阻塞。
 *
 * 两种用法：
 *   独立进程（生产拆分）：node src/worker.js
 *     —— 事件经 src/worker-relay.js 写 worker_events 表，API 进程泵回 SSE；
 *     —— 与 API 同库（BRAINX_DB），WAL 多进程读写安全（busy_timeout=5000）。
 *   嵌入模式（开发/单进程）：server.js 主块直接调 startWorkerTasks(db, bus)，
 *     —— 行为与拆分前完全一致（默认，BRAINX_EMBED_WORKER 未设 '0' 时）。
 */
import './env.js';
import { openDb } from './db.js';
import { startBridge } from './bridge.js';
import { startScheduler } from './scheduler.js';
import { makeAutoPush } from './autopush.js';
import { recommend, loadConsultants } from './recommend.js';
import { relayBus } from './worker-relay.js';

/** 启动全部批处理任务。bus 由调用方给（嵌入=server.bus；独立=relayBus）。 */
export function startWorkerTasks(db, bus) {
  const handles = [];
  // 桥接常驻：BRAINX_BRIDGE_INTERVAL_MS（默认 180s）；BRAINX_BRIDGE_OFF=1 关闭
  if (process.env.BRAINX_BRIDGE_OFF !== '1') {
    handles.push(startBridge(db, bus, {
      recommendFn: (cid) => recommend(db, cid, { top: 20, throttle: true }), // 方案 A：快照未变<2h 跳过冻结
      consultantIdsFn: () => loadConsultants(db).map((c) => c.consultant_id),
      onRecommended: makeAutoPush(db), // 重大变化自动推卡；BRAINX_PUSH_AUTO=1 才真发
    }));
    console.log(`[worker] 桥接器已启动（间隔 ${Number(process.env.BRAINX_BRIDGE_INTERVAL_MS || 180000) / 1000}s）`);
  }
  // 定时推送：每天 07:00 / 19:00（CST）；BRAINX_PUSH_SCHEDULE=0 关闭
  handles.push(startScheduler(db));
  console.log('[worker] 定时推送已启动（07:00 / 19:00 CST）');
  return { stop: () => handles.forEach((h) => h?.stop?.()) };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = openDb();
  const tasks = startWorkerTasks(db, relayBus(db)); // 事件写表，API 进程泵回浏览器 SSE
  console.log('[worker] 批处理进程已就绪（与 API 同库，经 worker_events 接力 SSE）');
  // 保活（2026-08-30 生产事故修复）：bridge/scheduler 的定时器全部 unref——那是嵌入
  // 模式的正确行为（不挡 API 优雅停机），但独立进程里事件循环没有任何 ref'd handle，
  // 启动即 exit 0，systemd Restart=always 每 10s 空转重启（实测 NRestarts 50+，批处理
  // 实际全停）。用一个保活定时器撑住事件循环；SIGTERM/SIGINT 时清掉再退出。
  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = () => { clearInterval(keepAlive); tasks.stop(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
