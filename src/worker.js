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
import { intakeAllConsultants } from './resume-intake.js';
import { startOpenmaiDeliveryWorker } from './openmai-delivery.js';
import { startProjectReminderWorker } from './project-reminder.js';
import { startStageReminderWorker } from './stage-reminder.js';
import { startOpenclawGroupRetryWorker } from './openclaw-group-retry.js';
import { startGroupIntakeWorker } from './group-intake.js';

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

  if (process.env.BRAINX_OPENMAI_DELIVERY_OFF !== '1') {
    handles.push(startOpenmaiDeliveryWorker(db));
    console.log('[worker] OpenMai 项目群投递已启动');
  }

  // 项目轻量提醒：群内静默 72h 唤醒卡（specs/009）；BRAINX_PROJECT_REMINDER_OFF=1 关闭
  if (process.env.BRAINX_PROJECT_REMINDER_OFF !== '1') {
    handles.push(startProjectReminderWorker(db));
    console.log('[worker] 项目轻量提醒已启动（静默 72h 唤醒，09-21 CST 窗口）');
  }

  // 每日分阶段推进提醒：私聊 DM（specs/010）；BRAINX_STAGE_REMINDER_OFF=1 关闭
  if (process.env.BRAINX_STAGE_REMINDER_OFF !== '1') {
    handles.push(startStageReminderWorker(db));
    console.log('[worker] 每日阶段提醒已启动（工作日 12:30 CST 后首周期，按项目逐条）');
  }

  // 简历文件入口：飞书群/私聊的 PDF/DOCX → 解析入库（BRAINX_RESUME_INTAKE_OFF=1 关闭）
  if (process.env.BRAINX_RESUME_INTAKE_OFF !== '1') {
    const iv = Number(process.env.BRAINX_RESUME_INTAKE_INTERVAL_MS || 300000);
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const out = await intakeAllConsultants(db);
        if (out.ingested) console.log(`[worker] 简历入库 ${out.ingested} 份（${out.at}）`);
      } catch (e) { console.error(`[worker] 简历入口异常: ${String(e.message || e).slice(0, 120)}`); }
      finally { running = false; }
    };
    const timer = setInterval(tick, iv);
    timer.unref?.();
    handles.push({ stop: () => clearInterval(timer) });
    console.log(`[worker] 简历文件入口已启动（间隔 ${iv / 1000}s）`);
  }

  // OpenClaw 群准入补偿：卡片已发但准入失败的群定时重试（specs/013）；BRAINX_OPENCLAW_RETRY_OFF=1 关闭
  if (process.env.BRAINX_OPENCLAW_RETRY_OFF !== '1') {
    handles.push(startOpenclawGroupRetryWorker(db));
    const iv = Number(process.env.BRAINX_OPENCLAW_RETRY_INTERVAL_MS || 600000) / 1000;
    console.log(`[worker] OpenClaw 群准入补偿已启动（间隔 ${iv}s，成功后节流重启 gateway）`);
  }
  // 机器人进旧群轮询：发现新群发「绑定职位」卡（specs/015）；BRAINX_GROUP_INTAKE_OFF=1 关闭
  if (process.env.BRAINX_GROUP_INTAKE_OFF !== '1') {
    startGroupIntakeWorker(db);
    const iv = Number(process.env.BRAINX_GROUP_INTAKE_INTERVAL_MS || 600000) / 1000;
    console.log(`[worker] 机器人进群轮询已启动（间隔 ${iv}s，首轮只基线不发卡）`);
  }
  return { stop: () => handles.forEach((h) => h?.stop?.()) };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = openDb();
  const tasks = startWorkerTasks(db, relayBus(db)); // 事件写表，API 进程泵回浏览器 SSE
  // 保活（2026-08-30 生产事故修复）：bridge/scheduler 的定时器全部 unref——那是嵌入
  // 模式的正确行为（不挡 API 优雅停机），但独立进程里事件循环没有任何 ref'd handle，
  // 启动即 exit 0，systemd Restart=always 每 10s 空转重启（实测 NRestarts 50+，批处理
  // 实际全停）。用一个保活定时器撑住事件循环；SIGTERM/SIGINT 时清掉再退出。
  const keepAlive = setInterval(() => {}, 1 << 30);
  const shutdown = () => { clearInterval(keepAlive); tasks.stop(); process.exit(0); };
  // 顺序要求：信号处理器必须早于「已就绪」日志注册。tests/worker.test.mjs 以该日志
  // 作为「可以发 SIGTERM」的信号，若注册在后，信号会在处理器就位前送达而走默认
  // 行为杀死进程（exit code null），full 门禁偶发假失败（2026-09-03 与 2026-09-11 实测）。
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  console.log('[worker] 批处理进程已就绪（与 API 同库，经 worker_events 接力 SSE）');
}
