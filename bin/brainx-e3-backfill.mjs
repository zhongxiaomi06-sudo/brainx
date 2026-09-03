#!/usr/bin/env node
/** brainx-e3-backfill — E3 提炼闭环存量回填（2026-09-03）。
 * 从 job_messages 表（bridge 已落库的历史消息）补进 账本→draft 闭环。
 * 幂等三层去重，重复跑安全。默认 dry 统计；--apply 才真写。
 * 用法：node bin/brainx-e3-backfill.mjs [--chat oc_xxx] [--days 7] [--limit 500] [--apply]
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { backfillFromJobMessages } from '../src/job-extract/bridge-producer.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const db = openDb(arg('db', undefined));
const opts = { chat_id: arg('chat', null), days: Number(arg('days', '7')), limit: Number(arg('limit', '500')) };
if (!process.argv.includes('--apply')) {
  const cutoff = new Date(Date.now() - opts.days * 86400000).toISOString();
  const n = db.prepare(`SELECT COUNT(*) n FROM job_messages
    WHERE ingested_at >= ? ${opts.chat_id ? 'AND chat_id=?' : ''}`)
    .get(...(opts.chat_id ? [cutoff, opts.chat_id] : [cutoff])).n;
  console.log(JSON.stringify({ dry_run: true, ...opts, messages_in_window: n,
    note: '确认后加 --apply 执行（幂等，重复安全）' }, null, 2));
  process.exit(0);
}
const out = backfillFromJobMessages(db, opts);
console.log(JSON.stringify({ dry_run: false, ...opts, ...out }, null, 2));
