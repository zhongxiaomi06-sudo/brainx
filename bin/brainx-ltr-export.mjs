#!/usr/bin/env node
/** brainx-ltr-export.mjs — LambdaMART 训练样本导出（算法文档 §4/§7 阶段二）。
 * 行 = 曝光 × 标签 × 特征（只含已展示或已互动的曝光；未展示=未知按纪律剔除）。
 * 排序组 = run_id（顾问×推荐批次）。输出 JSONL 到 data/ltr-export.jsonl。
 * 用法：node bin/brainx-ltr-export.mjs --cutoff-at <ISO> --window-days <1-365>
 *      [--db <path>] [--out data/ltr-export.jsonl]
 */
import '../src/env.js';
import { writeFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { readFeatureSnapshot, LTR_FEATURE_VERSION, LTR_FEATURES } from '../src/ltr-features.js';
import { loadConsultants } from '../src/recommend.js';
import { RANKING_METRIC_VERSION } from '../src/ranking-metrics.js';
import { evaluationLabelFor, RANKING_LABEL_VERSION, validateLabelWindow } from '../src/ranking-labels.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const OUT = arg('out', 'data/ltr-export.jsonl');

export function exportDataset(db, { cutoffAt, windowDays } = {}) {
  const labelWindow = validateLabelWindow({ cutoffAt, windowDays });
  const rows = [];
  const excluded = {};
  for (const c of loadConsultants(db)) {
    // 曝光优先取 impressions（0021 起）；旧轮次无 impressions 行时以 recommendations 行
    // 本身作曝光记录（rank 已冻结可考），标签存在即证明发生过互动（§4 纪律：
    // 无标签=未知一律剔除，不臆造负反馈）。
    const imps = db.prepare(`SELECT i.decision_id, i.run_id, i.project_id, i.rank, i.slot_kind, i.propensity,
        i.policy_version, i.served_at, i.created_at
      FROM recommendation_impressions i WHERE i.consultant_id=?
      UNION ALL
      SELECT r.decision_id, r.run_id, r.project_id, r.rank, 'NORMAL' AS slot_kind, 1.0 AS propensity,
        r.policy_version, NULL AS served_at, r.created_at
      FROM recommendations r
      WHERE r.consultant_id=? AND NOT EXISTS (
        SELECT 1 FROM recommendation_impressions i2
        WHERE i2.run_id=r.run_id AND i2.project_id=r.project_id)
      ORDER BY created_at DESC`).all(c.consultant_id, c.consultant_id);
    for (const imp of imps) {
      const labelResult = evaluationLabelFor(db, imp.decision_id, labelWindow);
      if (labelResult.status !== 'MATURE' || labelResult.label === null) {
        excluded[labelResult.reason] = (excluded[labelResult.reason] || 0) + 1;
        continue;
      }
      const rec = db.prepare(`SELECT feature_snapshot_json
        FROM recommendations WHERE run_id=? AND project_id=?`)
        .get(imp.run_id, imp.project_id);
      if (!rec) continue;
      const snapshot = readFeatureSnapshot(rec.feature_snapshot_json);
      if (!snapshot.ok) {
        excluded[snapshot.reason] = (excluded[snapshot.reason] || 0) + 1;
        continue;
      }
      rows.push({ group: imp.run_id, consultant_id: c.consultant_id, project_id: imp.project_id,
        decision_id: imp.decision_id, rank: imp.rank, label: labelResult.label,
        slot_kind: imp.slot_kind, propensity: imp.propensity,
        features: snapshot.features, feature_version: snapshot.schema_version,
        feature_captured_at: snapshot.captured_at, label_version: labelResult.version,
        label_window_days: labelResult.window_days, label_cutoff_at: labelResult.cutoff_at,
        created_at: imp.created_at });
    }
  }
  return { rows, excluded, labelWindow };
}

export function exportRows(db, options) {
  return exportDataset(db, options).rows;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const cutoffAt = arg('cutoff-at', null);
  const windowDays = Number(arg('window-days', ''));
  let labelWindow;
  try {
    labelWindow = validateLabelWindow({ cutoffAt, windowDays });
  } catch (error) {
    console.error(`必须提供合法 --cutoff-at <ISO> 和 --window-days <1-365>：${error.message}`);
    process.exit(2);
  }
  const db = openDb(arg('db', undefined));
  const dataset = exportDataset(db, labelWindow);
  const { rows, excluded } = dataset;
  const header = { feature_version: LTR_FEATURE_VERSION, metric_version: RANKING_METRIC_VERSION,
                   label_version: RANKING_LABEL_VERSION, label_window_days: labelWindow.windowDays,
                   label_cutoff_at: labelWindow.cutoffAt, feature_order: LTR_FEATURES,
                   rows: rows.length, excluded, exported_at: now() };
  writeFileSync(OUT, JSON.stringify(header) + '\n'
    + rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const byLabel = {};
  for (const r of rows) byLabel[r.label] = (byLabel[r.label] || 0) + 1;
  console.log(JSON.stringify({ out: OUT, rows: rows.length, excluded, by_label: byLabel }, null, 2));
}
