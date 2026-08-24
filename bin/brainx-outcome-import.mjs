#!/usr/bin/env node
/** brainx-outcome-import — 批量补录交付结果到 job_outcomes（2026-08-24 F4）。
 *
 * 背景：job_outcomes 全表仅 1 行（健康简报 2026-08-24：5 个 ACCEPTED 无 outcome），
 * 历史交付结果散落在 CRM/表格里没人逐条录 UI。本脚本从 CSV 幂等补录，
 * 写入路径与 UI/MCP 完全一致（recordOutcome）。
 *
 * CSV（含表头，逗号分隔）：
 *   consultant,project,stage,rating,date
 *   felix,JDWIAC3,面试,4,2026-08-21
 *   - stage：推荐采纳|面试|Offer|入职|关闭|反馈（自由文本，建议沿用枚举）
 *   - rating：1-5，可空
 *   - date：YYYY-MM-DD（幂等键组成部分；同一天同职位同阶段重复导入自动跳过）
 *
 * 用法：node bin/brainx-outcome-import.mjs --file outcomes.csv [--dry-run]
 */
import '../src/env.js';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { recordOutcome } from '../src/replay.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const file = arg('file', null);
const dryRun = process.argv.includes('--dry-run');
if (!file) { console.error('用法：--file outcomes.csv [--dry-run]'); process.exit(2); }

const lines = readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const header = lines.shift().split(',').map((s) => s.trim());
const need = ['consultant', 'project', 'stage', 'rating', 'date'];
for (const c of need) if (!header.includes(c)) { console.error(`CSV 缺列：${c}（需要 ${need.join(',')}）`); process.exit(2); }

const rows = lines.map((l, i) => {
  const cells = l.split(',').map((s) => s.trim());
  const r = Object.fromEntries(header.map((h, j) => [h, cells[j] ?? '']));
  return { line: i + 2, ...r };
});

const db = openDb();
const results = { total: rows.length, inserted: 0, already: 0, failed: [] };
for (const r of rows) {
  if (!r.consultant || !r.project || !r.stage) {
    results.failed.push({ line: r.line, error: 'consultant/project/stage 不能为空', row: r }); continue;
  }
  const rating = Number(r.rating);
  const value = {};
  if (r.rating !== '' && Number.isFinite(rating)) value.rating = Math.min(5, Math.max(1, rating));
  if (dryRun) { results.inserted++; continue; }
  const out = recordOutcome(db, r.consultant, {
    project_id: r.project, stage: r.stage, value,
    idempotency_key: `outcome-import:${r.consultant}:${r.project}:${r.stage}:${r.date || 'nodate'}`,
  });
  if (!out.ok) results.failed.push({ line: r.line, error: out.error, row: r });
  else if (out.already) results.already++;
  else results.inserted++;
}

console.log(JSON.stringify({ dry_run: dryRun, ...results }, null, 2));
process.exit(results.failed.length ? 1 : 0);
