#!/usr/bin/env node
/** brainx-label-import — 人工打标表幂等导入（2026-08-24 Phase ④）。
 *
 * 写入目标：job_outcomes（stage='人工标注'，value_json={label, reason, scheme:'v1'}）。
 * 为什么不写 recommendation_feedback：该表会触发 scorer「不感兴趣降权」，
 * 而「会接/会看」是正标签，混用会污染生产排序；job_outcomes 只被 replay/评估
 * 读取（recommend.js 只取 $.rating），天然隔离且回放可查。
 *
 * 幂等与冲突：同一 （顾问， 职位） 只允许一条 v1 标注；重复导入跳过；
 * 已存在但 label 不同 → 记 conflict 不覆盖（人工裁决后改 scheme 版本号再导）。
 *
 * 用法：node bin/brainx-label-import.mjs --file data/labeling/labels-v1.csv [--dry-run]
 */
import '../src/env.js';
import { readFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';

const LABELS = ['会接', '会看', '没兴趣', '不确定'];
const REASONS = ['无资源', '不符合方向', '客户/职位质量不足', '当前没精力', '已有其他顾问推进', '信息不完整', '其他', ''];

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const file = arg('file', null);
const dryRun = process.argv.includes('--dry-run');
if (!file) { console.error('用法：--file labels.csv [--dry-run]'); process.exit(2); }

/** 引号感知的 CSV 解析（与 export 的 csvCell 转义对应；支持引号内换行/逗号/双引号）。 */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const endField = () => { row.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') endField();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endField();
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  endField();
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const lines = parseCsv(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // 剥 BOM：Excel「CSV UTF-8」另存必带
const header = lines.shift().map((s) => s.trim());
for (const c of ['consultant', 'project_id', 'label', 'reason']) {
  if (!header.includes(c)) { console.error(`CSV 缺列：${c}`); process.exit(2); }
}

const db = openDb();
const results = { total: 0, inserted: 0, skipped_blank: 0, already: 0, conflicts: [], failed: [] };
const ins = db.prepare(`INSERT INTO job_outcomes
  (project_id, consultant_id, stage, value_json, decision_id, idempotency_key, observed_at)
  VALUES (?,?,?,?,?,?,?)`);
const findExisting = db.prepare(`SELECT value_json FROM job_outcomes
  WHERE consultant_id=? AND project_id=? AND stage='人工标注'
  AND json_extract(value_json,'$.scheme')='v1' LIMIT 1`);

for (const cells of lines) {
  const r = Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? '').trim()]));
  results.total++;
  if (!r.label) { results.skipped_blank++; continue; }
  if (!LABELS.includes(r.label)) { results.failed.push({ project_id: r.project_id, error: `label 非法：${r.label}` }); continue; }
  if (!REASONS.includes(r.reason)) { results.failed.push({ project_id: r.project_id, error: `reason 非法：${r.reason}` }); continue; }
  if (r.reason === '') r.reason = '其他';
  const existing = findExisting.get(r.consultant, r.project_id);
  if (existing) {
    const prev = JSON.parse(existing.value_json);
    if (prev.label !== r.label) results.conflicts.push({ project_id: r.project_id, consultant: r.consultant, was: prev.label, now: r.label });
    else results.already++;
    continue;
  }
  if (dryRun) { results.inserted++; continue; }
  try {
    ins.run(r.project_id, r.consultant, '人工标注',
      JSON.stringify({ label: r.label, reason: r.reason, scheme: 'v1', labeled_by: r.consultant }),
      null, `label-v1:${r.consultant}:${r.project_id}`, now());
    results.inserted++;
  } catch (e) {
    results.failed.push({ project_id: r.project_id, error: String(e.message).slice(0, 120) });
  }
}

console.log(JSON.stringify({ dry_run: dryRun, ...results }, null, 2));
process.exit(results.failed.length || results.conflicts.length ? 1 : 0);
