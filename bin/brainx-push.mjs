#!/usr/bin/env node
/** brainx-push --consultant mia [--target ou_xxx] [--slot 0700|1900] [--send]（默认只预览）
 *  [--exclude-pushed-today] 去掉今日已推过的职位（顾问要求再次推送且不要重复时使用） */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { latestSync, latestCompleteSnapshot } from '../src/sync.js';
import { latestRun, loadConsultants } from '../src/recommend.js';
import { commitmentSummary } from '../src/engagement.js';
import { buildDailyCard, buildSyncAlertCard, pushCard, pushedProjectIdsOnDay } from '../src/push.js';
import { DEFAULT_PUSH_PREFERENCES, getPushPreferences } from '../src/push-preferences.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const cid = arg('consultant', 'felix');
const db = openDb();
const sync = latestSync(db, cid);
const snapshot = latestCompleteSnapshot(db, cid);
const run = latestRun(db, cid, { hideEngaged: true });
const c = commitmentSummary(db, cid);
const consultant = loadConsultants(db).find((x) => x.consultant_id === cid);
const name = consultant?.display_name || cid;
const preferences = getPushPreferences(db, cid) || DEFAULT_PUSH_PREFERENCES;
const cstDay = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
// 去重再推（2026-09-28 指令）：剔除今日已推职位；全被推过则明确告知，不发空卡
let items = run?.items || [];
if (process.argv.includes('--exclude-pushed-today')) {
  const seen = pushedProjectIdsOnDay(db, cid, cstDay);
  items = items.filter((r) => !seen.has(r.job?.project_id));
  if (!items.length) {
    console.log(JSON.stringify({ consultant: cid, skipped: 'no_new_items', note: '今日已推职位全部去重，无新内容可推' }));
    process.exit(0);
  }
}
const kind = sync && !sync.complete ? 'SYNC_ALERT' : 'DAILY_TOP3';
const card = kind === 'SYNC_ALERT' ? buildSyncAlertCard(sync)
  : buildDailyCard({ consultant_name: name, consultant_id: cid, run: run?.run,
                     items: items.slice(0, preferences.job_count), item_limit: preferences.job_count,
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
const deliveryKey = slot ? `openclaw:${cstDay}#${slot}` : run?.run?.run_id || null;
const out = await pushCard(db, { consultant_id: cid, kind, run_id: deliveryKey, card, target, send: true });
console.log(JSON.stringify(out, null, 2));
