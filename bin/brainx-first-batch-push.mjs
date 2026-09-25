#!/usr/bin/env node
/** brainx-first-batch-push — 第一批（客户健康报告覆盖群）算法驱动推送（specs/022 US6 增量）。
 *
 * 链路：consultant_chats ⋈ client_metrics 取第一批顾问 → 该顾问最新一轮算法推荐
 * （recommend() 六维加权 scorer 的冻结输出，本脚本不另起跑批、不改线上排序）→
 * 生命周期策略层（dormant 客户名下职位剔除[SC-6 完全静默]、cold_start 标注「破冰优先」）→
 * buildDailyCard 出卡 → pushCard（kind='FIRST_BATCH_TOP3'，run_id 幂等）。
 *
 * 安全边界（与 autopush 同一约定）：只推顾问本人 open_id 私聊，绝不推群；
 * 默认预览，--send 才真发。
 * 用法：node bin/brainx-first-batch-push.mjs [--send] [--card <consultant_id>] [--db <path>]
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { latestSync } from '../src/sync.js';
import { latestRun } from '../src/recommend.js';
import { commitmentSummary } from '../src/engagement.js';
import { buildDailyCard, pushCard } from '../src/push.js';
import { DEFAULT_PUSH_PREFERENCES, getPushPreferences } from '../src/push-preferences.js';
import { listFirstBatchConsultants, applyLifecyclePolicy } from '../src/client-metrics.js';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : null; };
const SEND = process.argv.includes('--send');

async function main() {
  const db = openDb(arg('db') || undefined);
  const consultants = listFirstBatchConsultants(db);
  if (!consultants.length) {
    console.log('第一批顾问为空（consultant_chats ⋈ client_metrics 无交集），先导入 client_metrics');
    process.exit(0);
  }
  console.log(`第一批顾问 ${consultants.length} 人（覆盖客户群 ${consultants.reduce((s, c) => s + c.client_count, 0)} 个）`);
  const summary = [];
  for (const c of consultants) {
    const sync = latestSync(db, c.consultant_id);
    if (!sync?.complete) { summary.push({ consultant: c.consultant_id, skipped: '同步不完整' }); continue; }
    const run = latestRun(db, c.consultant_id, { hideEngaged: true });
    if (!run?.items?.length) { summary.push({ consultant: c.consultant_id, skipped: '无推荐轮次' }); continue; }
    const { items, dropped, tagged } = applyLifecyclePolicy(db, run.items);
    if (!items.length) { summary.push({ consultant: c.consultant_id, skipped: '策略后无职位', dropped }); continue; }
    const preferences = getPushPreferences(db, c.consultant_id) || DEFAULT_PUSH_PREFERENCES;
    const card = buildDailyCard({
      consultant_name: c.display_name, consultant_id: c.consultant_id,
      run: run.run, items: items.slice(0, preferences.job_count), item_limit: preferences.job_count,
      commitments: commitmentSummary(db, c.consultant_id), sync,
    });
    const entry = { consultant: c.consultant_id, run_id: run.run.run_id,
      pushed: items.length, dropped_dormant: dropped, tagged_cold_start: tagged };
    if (arg('card') === c.consultant_id) console.log(JSON.stringify(card, null, 2));
    if (SEND) {
      if (!c.open_id) { entry.sent = false; entry.error = '无 open_id'; }
      else {
        const r = await pushCard(db, { consultant_id: c.consultant_id, kind: 'FIRST_BATCH_TOP3',
          run_id: run.run.run_id, card, target: c.open_id, send: true });
        entry.sent = r?.status === 'SENT';
        entry.push_status = r?.status;
      }
    }
    summary.push(entry);
  }
  console.log(JSON.stringify(summary, null, 2));
  if (!SEND) console.error('（预览模式，加 --send 才真发私聊；绝不存在群推送路径）');
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
