#!/usr/bin/env node
/** braintex-local-ttc-sync — 用已托管 TTC JWT 实时拉取职位入库（真 project_id = TTC unique_id）。
 * 用法：
 *   node bin/brainx-ttc-sync.mjs [--consultant felix] [--dry-run] [--max-pages 100]
 * 前置：浏览器扩展扫码同步过 TTC 凭证（ttc_tokens 有有效 JWT）。
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { getValidTtcJwt } from '../src/ttcsdk/auth.js';
import { searchAll, toJobRow } from '../src/ttcsdk/job.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const consultant = arg('consultant', 'felix');
const dryRun = process.argv.includes('--dry-run');
const maxPages = Number(arg('max-pages', '100'));

const db = openDb();
const jwt = getValidTtcJwt(db, consultant);
if (!jwt) {
  console.error(`❌ ${consultant} 没有有效 TTC 凭证——先安装扩展打开 app.ttcadvisory.com 扫码同步，或到凭证中心粘贴 JWT`);
  process.exit(1);
}

console.log(`[ttc-sync] 顾问 ${consultant} · 拉取 TTC 职位…（max ${maxPages} 页）`);
const jobs = await searchAll(jwt, {});
console.log(`[ttc-sync] TTC 返回 ${jobs.length} 个职位`);

if (!jobs.length) {
  console.error('⚠️ 没有职位（JWT 权限视图内为空）');
  process.exit(0);
}

const rows = [];
let confidential = 0;
for (const j of jobs) {
  const row = toJobRow(j);
  // 机密客户职位（need_blur=1 且无候选人可见名 → company 为空）：无展示价值，跳过避免拖垮整批
  if (!row.company) { confidential += 1; continue; }
  rows.push(row);
}
console.log(`[ttc-sync] 跳过 ${confidential} 个机密客户职位（无客户名，不入库）`);
if (!rows.length) {
  console.error('⚠️ 没有可入库的职位');
  process.exit(0);
}

const out = runSync(db, {
  source: 'ttc',
  consultant_id: consultant,
  dry_run: dryRun,
  payload: { as_of: new Date().toISOString(), jobs: rows },
});

console.log(JSON.stringify({ ttc_jobs: jobs.length, confidential_skipped: confidential, ...out }, null, 2));
console.error(out.complete
  ? `✅ 同步完整：${out.rows_read}/${out.rows_expected} 行（${out.warnings?.length || 0} 条去重警告）`
  : `⚠️ 不完整：${out.errors.length} 条错误（complete=0）`);
