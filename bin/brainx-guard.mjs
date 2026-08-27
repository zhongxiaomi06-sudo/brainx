#!/usr/bin/env node
/** brainx-guard.mjs — 请求带宽/调用量预测告警看门狗（配合 server 内 GET /api/v1/meta/guard）。
 *
 * 预测装置：对请求速率/带宽做 EWMA 基线外推，当前值超过绝对阈值或相对基线
 * 突增（spike-mult 倍）即告警；单路由洪峰单独盯（防快照接口被并发打爆）。
 *
 * 用法：
 *   node bin/brainx-guard.mjs [--url http://127.0.0.1:3000] [--interval 30]
 *        [--max-rpm 600] [--max-bps 5242880] [--spike-mult 3] [--max-route-rpm 240]
 *        [--webhook https://open.feishu.cn/open-apis/bot/v2/hook/xxx] [--once]
 *   node bin/brainx-guard.mjs --selftest   # 起临时服务模拟突发流量，实测告警触发
 *
 * 退出码：0=正常（或 selftest 通过） 1=探测失败 2=已告警。
 */
import { detect } from '../src/guard.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { createServer } from '../src/server.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes(`--${k}`);
const base = arg('url', 'http://127.0.0.1:3000');
let interval = Number(arg('interval', '30'));
if (!Number.isFinite(interval) || interval < 1) { console.error('[guard] --interval 非法，回退 30s'); interval = 30; } // NaN→setInterval 1ms 会洪峰自家 API
const webhook = arg('webhook', process.env.BRAINX_GUARD_WEBHOOK || '');
const opts = {
  maxRpm: Number(arg('max-rpm', '600')),
  maxBps: Number(arg('max-bps', String(5 * 1024 * 1024))),
  spikeMult: Number(arg('spike-mult', '3')),
  maxRouteRpm: Number(arg('max-route-rpm', '240')),
};

let baseline = null;

async function fetchSnap() {
  const r = await fetch(`${base}/api/v1/meta/guard`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function notify(alerts, snap) {
  const lines = [
    `🚨 BrainX 预警：${alerts.length} 项异常（${new Date().toISOString()}）`,
    ...alerts.map((a) => `  - ${a}`),
    `  当前 rpm=${snap.rpm} bps=${(snap.bps / 1024 / 1024).toFixed(2)}MB/s 基线 rpm=${snap.baseline?.rpm.toFixed(1) ?? 'n/a'}`,
  ];
  const text = lines.join('\n');
  console.error(text);
  if (webhook) {
    try {
      const w = await fetch(webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msg_type: 'text', content: { text } }),
      });
      console.error(`[webhook] HTTP ${w.status}`);
    } catch (e) { console.error(`[webhook] 推送失败：${e.message}`); }
  }
}

async function tick() {
  let snap;
  try { snap = await fetchSnap(); }
  catch (e) { console.error(`[guard] 探测失败：${e.message}`); return 1; }
  const out = detect(snap, baseline, opts);
  baseline = out.baseline;
  if (out.alerted) { await notify(out.alerts, { ...snap, rpm: out.rpm, bps: out.bps, baseline }); return 2; }
  console.log(`[guard] OK rpm=${out.rpm} bps=${(out.bps / 1024 / 1024).toFixed(2)}MB/s 基线=${out.baseline.rpm.toFixed(1)} (${out.reason})`);
  return 0;
}

async function selftest() {
  console.log('[selftest] 起临时服务 + 内存库…');
  process.env.BRAINX_SNAPSHOT_API_KEY = 'selftest-snap-key';
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const b = `http://127.0.0.1:${server.address().port}`;
  try {
    // 1) 预热：少量请求建立基线
    for (let i = 0; i < 15; i++) await fetch(`${b}/api/v1/meta/guard`);
    const warm = await (await fetch(`${b}/api/v1/meta/guard`)).json();
    const warmOut = detect(warm, null, opts);
    console.log(`[selftest] 基线 rpm=${warmOut.baseline.rpm.toFixed(1)}`);
    // 2) 突发：~2s 内 400 次打快照接口（模拟 York 9 worker 并发拉全量）
    const t0 = Date.now();
    const jobs = [];
    for (let i = 0; i < 400; i++) {
      jobs.push(fetch(`${b}/api/v1/jobs/snapshot`, {
        headers: { Authorization: 'Bearer selftest-snap-key' },
      }).catch(() => null));
      if (i % 100 === 99) await new Promise((r2) => setTimeout(r2, 250));
    }
    await Promise.all(jobs);
    const dt = (Date.now() - t0) / 1000;
    const snap = await (await fetch(`${b}/api/v1/meta/guard`)).json();
    const out = detect(snap, warmOut.baseline, { ...opts, maxRpm: 300, maxRouteRpm: 200, spikeMult: 2 });
    console.log(`[selftest] 突发 ${jobs.length} 请求 / ${dt.toFixed(1)}s → rpm=${out.rpm} 路由=${JSON.stringify(snap.per_minute.by_route)}`);
    if (out.alerted) {
      console.log('✅ [selftest] 告警已触发：');
      for (const a of out.alerts) console.log(`   - ${a}`);
      return 0;
    }
    console.log('❌ [selftest] 突发流量未触发任何告警（检测器失效？）');
    return 1;
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

if (has('selftest')) process.exit(await selftest());
else if (has('once')) process.exit(await tick());
else {
  console.log(`[guard] 看门狗启动：url=${base} interval=${interval}s maxRpm=${opts.maxRpm} maxBps=${(opts.maxBps / 1024 / 1024).toFixed(0)}MB/s spike×${opts.spikeMult}`);
  setInterval(async () => { const c = await tick(); if (c === 2) { /* 已告警，继续盯 */ } }, interval * 1000);
}
