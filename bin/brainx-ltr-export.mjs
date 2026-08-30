#!/usr/bin/env node
/** brainx-ltr-export.mjs — LambdaMART 训练样本导出（算法文档 §4/§7 阶段二）。
 * 行 = 曝光 × 标签 × 特征（只含已展示或已互动的曝光；未展示=未知按纪律剔除）。
 * 排序组 = run_id（顾问×推荐批次）。输出 JSONL 到 data/ltr-export.jsonl。
 * 用法：node bin/brainx-ltr-export.mjs [--db <path>] [--out data/ltr-export.jsonl]
 */
import '../src/env.js';
import { writeFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { labelFor } from '../src/labels.js';
import { featuresOf, LTR_FEATURE_VERSION, LTR_FEATURES } from '../src/ltr-features.js';
import { loadConsultants } from '../src/recommend.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'data/ltr-export.jsonl');

export function exportRows(db) {
  const rows = [];
  for (const c of loadConsultants(db)) {
    // 曝光优先取 impressions（0021 起）；旧轮次无 impressions 行时以 recommendations 行
    // 本身作曝光记录（rank 已冻结可考），标签存在即证明发生过互动（§4 纪律：
    // 无标签=未知一律剔除，不臆造负反馈）。
    const imps = db.prepare(`SELECT i.run_id, i.project_id, i.rank, i.slot_kind, i.propensity,
        i.policy_version, i.served_at, i.created_at
      FROM recommendation_impressions i WHERE i.consultant_id=?
      UNION ALL
      SELECT r.run_id, r.project_id, r.rank, 'NORMAL' AS slot_kind, 1.0 AS propensity,
        r.policy_version, NULL AS served_at, r.created_at
      FROM recommendations r
      WHERE r.consultant_id=? AND NOT EXISTS (
        SELECT 1 FROM recommendation_impressions i2
        WHERE i2.run_id=r.run_id AND i2.project_id=r.project_id)
      ORDER BY created_at DESC`).all(c.consultant_id, c.consultant_id);
    for (const imp of imps) {
      const label = labelFor(db, c.consultant_id, imp.project_id);
      if (label === null) continue; // 未互动=未知，不打标（§4 纪律）
      const rec = db.prepare(`SELECT decision_id, action, score, evidence_coverage, breakdown_json
        FROM recommendations WHERE run_id=? AND project_id=?`)
        .get(imp.run_id, imp.project_id);
      if (!rec) continue;
      const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(imp.project_id);
      const feat = featuresOf({ ...rec, breakdown: JSON.parse(rec.breakdown_json || '{}'), job },
        { nowIso: imp.created_at });
      rows.push({ group: imp.run_id, consultant_id: c.consultant_id, project_id: imp.project_id,
        rank: imp.rank, label, slot_kind: imp.slot_kind, propensity: imp.propensity,
        features: feat, feature_version: LTR_FEATURE_VERSION, created_at: imp.created_at });
    }
  }
  return rows;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = openDb(arg('db', undefined));
  const rows = exportRows(db);
  const header = { feature_version: LTR_FEATURE_VERSION, feature_order: LTR_FEATURES,
                   rows: rows.length, exported_at: now() };
  writeFileSync(OUT, JSON.stringify(header) + '\n'
    + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const byLabel = {};
  for (const r of rows) byLabel[r.label] = (byLabel[r.label] || 0) + 1;
  console.log(JSON.stringify({ out: OUT, rows: rows.length, by_label: byLabel }, null, 2));
}
