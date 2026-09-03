#!/usr/bin/env node
/** brainx-push --consultant mia [--target ou_xxx] [--slot 0700|1900] [--send]（默认只预览） */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { latestSync, latestCompleteSnapshot } from '../src/sync.js';
import { latestRun, loadConsultants } from '../src/recommend.js';
import { commitmentSummary } from '../src/engagement.js';
import { buildDailyCard, buildSyncAlertCard, pushCard } from '../src/push.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const cid = arg('consultant', 'felix');
const db = openDb();
const sync = latestSync(db, cid);
const snapshot = latestCompleteSnapshot(db, cid);
const run = latestRun(db, cid, { hideEngaged: true });
const c = commitmentSummary(db, cid);
const consultant = loadConsultants(db).find((x) => x.consultant_id === cid);
const name = consultant?.display_name || cid;
const kind = sync && !sync.complete ? 'SYNC_ALERT' : 'DAILY_TOP3';
const card = kind === 'SYNC_ALERT' ? buildSyncAlertCard(sync)
  : buildDailyCard({ consultant_name: name, consultant_id: cid, run: run?.run, items: run?.items || [],
                     commitments: c, sync, snapshot_id: snapshot?.sync_id });
if (!process.argv.includes('--send')) {
  console.log(JSON.stringify(card, null, 2));
  console.error('（预览模式，加 --send 才真正发送）');
  process.exit(0);
}
const target = arg('target', process.env.BRAINX_PUSH_TARGET
  || db.prepare('SELECT open_id FROM consultants WHERE consultant_id=?').get(cid)?.open_id || '');
if (!target) { console.error('该顾问没有 open_id，请配置 --target 或 BRAINX_PUSH_TARGET'); process.exit(1); }
const slot = arg('slot', '');
if (slot && !/^[A-Za-z0-9_-]{1,32}$/.test(slot)) { console.error('--slot 格式无效'); process.exit(1); }
const cstDay = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const deliveryKey = slot ? `openclaw:${cstDay}#${slot}` : run?.run?.run_id || null;
const out = await pushCard(db, { consultant_id: cid, kind, run_id: deliveryKey, card, target, send: true });
console.log(JSON.stringify(out, null, 2));
