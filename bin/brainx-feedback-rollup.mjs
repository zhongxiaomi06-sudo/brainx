#!/usr/bin/env node
/** brainx-feedback-rollup — specs/019 US3 反馈指标周期汇总。
 *  默认汇总最近 7 天窗口写 feedback_metrics（append-only，可重算），随后打印最新指标。
 *  用法：node bin/brainx-feedback-rollup.mjs [--days 7] [--print-only] [--db <path>] */
import '../src/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { runRollup, latestMetrics } from '../src/feedback/rollup.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const days = Number(arg('days', '7'));
const printOnly = process.argv.includes('--print-only');

const db = openDb(arg('db', join(ROOT, 'data', 'brainx.db')));
if (!printOnly) {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 86400000);
  const out = runRollup(db, {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  });
  console.log(JSON.stringify({ rollup: out, window_days: days }));
}
const latest = latestMetrics(db, {});
console.log(JSON.stringify({ latest_metrics: latest.map((m) => ({
  metric_key: m.metric_key, dimension: m.dimension,
  sample_size: m.sample_size, value_num: m.value_num,
  window: [m.window_start, m.window_end], computed_at: m.computed_at,
})) }, null, 2));
db.close();
