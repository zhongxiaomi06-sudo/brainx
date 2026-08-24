#!/usr/bin/env node
/** export-labeling-sheet — 导出首批人工打标表（2026-08-24 Phase ④，只读）。
 *
 * 对每位顾问最新一轮 Top20 生成标注 CSV：已有真实行为/反馈/结果覆盖的行
 * 在 existing_label 列标出（这些坑不用再标），空 label/reason 列待顾问填写。
 *
 * 用法：node scripts/export-labeling-sheet.mjs [--db data/brainx-cloud.db] [--out data/labeling/labels-v1.csv]
 * 填写后导入：node bin/brainx-label-import.mjs --file <填好的 CSV>
 */
import '../src/env.js';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };

/** 该 （顾问， 职位） 已有的真实标签来源（优先级从高到低）。 */
function existingLabel(db, cid, pid) {
  const o = db.prepare(`SELECT stage, value_json FROM job_outcomes
    WHERE consultant_id=? AND project_id=? ORDER BY observed_at DESC LIMIT 1`).get(cid, pid);
  if (o) return `结果:${o.stage}`;
  const e = db.prepare(`SELECT event_type FROM decision_events
    WHERE actor=? AND project_id=? AND event_type != 'RECOMMENDED'
    ORDER BY occurred_at DESC LIMIT 1`).get(cid, pid);
  if (e) return `行为:${e.event_type}`;
  const f = db.prepare(`SELECT 1 FROM recommendation_feedback
    WHERE consultant_id=? AND project_id=? LIMIT 1`).get(cid, pid);
  if (f) return '反馈:不感兴趣';
  return '';
}

export function exportSheet(db) {
  const consultants = db.prepare(`SELECT consultant_id, display_name FROM consultants WHERE active=1`).all();
  const rows = [];
  for (const c of consultants) {
    const run = db.prepare(`SELECT run_id FROM decision_runs WHERE consultant_id=?
      AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`).get(c.consultant_id);
    if (!run) continue;
    const items = db.prepare(`SELECT r.project_id, r.rank, r.score, j.company, j.role, j.active_state
      FROM recommendations r JOIN job_facts j ON j.project_id = r.project_id
      WHERE r.run_id=? AND r.rank<=20 ORDER BY r.rank`).all(run.run_id);
    const mine = [];
    for (const it of items) {
      mine.push({
        consultant: c.consultant_id, display_name: c.display_name,
        rank: it.rank, project_id: it.project_id, company: it.company, role: it.role,
        active_state: it.active_state, score: it.score,
        existing_label: existingLabel(db, c.consultant_id, it.project_id),
        label: '', reason: '',
      });
    }
    // 交叉验证题（labeling-standard-v1 §质量规则 3）：确定性抽 rank 5/15 复制到队尾，
    // 顾问不可见；同人两次答案不一致 → 导入端记 conflict。10% 重复，无随机数。
    const dups = mine.filter((r) => r.rank % 10 === 5).map((r) => ({ ...r }));
    rows.push(...mine, ...dups);
  }
  return rows;
}

const HEADER = ['consultant', 'display_name', 'rank', 'project_id', 'company', 'role',
                'active_state', 'score', 'existing_label', 'label', 'reason'];
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dbPath = arg('db', existsSync(join(ROOT, 'data', 'brainx-cloud.db'))
    ? join(ROOT, 'data', 'brainx-cloud.db') : join(ROOT, 'data', 'brainx.db'));
  const out = arg('out', join(ROOT, 'data', 'labeling', 'labels-v1.csv'));
  if (!existsSync(dbPath)) { console.error(`找不到库：${dbPath}`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = exportSheet(db);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, HEADER.join(',') + '\n'
    + rows.map((r) => HEADER.map((h) => csvCell(r[h])).join(',')).join('\n') + '\n');
  const need = rows.filter((r) => !r.existing_label).length;
  console.error(`[label:export] ${rows.length} 行（待标 ${need} / 已有标签 ${rows.length - need}）→ ${out}`);
  console.error('[label:export] label 填：会接|会看|没兴趣|不确定；reason 填：无资源|不符合方向|客户/职位质量不足|当前没精力|已有其他顾问推进|信息不完整|其他');
}
