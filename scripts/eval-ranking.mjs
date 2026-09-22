#!/usr/bin/env node
/** eval-ranking.mjs — 排序离线评估（算法文档 §6 验收层：召回/排序/稳定性）。
 * 只读。按「顾问 × 最近 N 轮」排序组计算：
 *   Recall@50   高价值岗位（label≥2）进入候选池 Top50 的比例
 *   NDCG@10     Top10 的折损累计增益（0–5 级标签）
 *   Precision@10 Top10 中 label≥2 的比例
 *   覆盖率      有标签岗位被评估进任意轮候选的比例
 * 纪律：按时间切分口径（标签只取评估时点之后的结果演化另算——当前快照口径为简化版，
 * 报告中明示限制）；与规则基线（当前线上六维评分）同批回放对照。
 * 用法：node scripts/eval-ranking.mjs --cutoff-at <ISO> --window-days <1-365>
 *      [--runs 5] [--db <path>] [--json]
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { labelsForRunAt, RANKING_LABEL_VERSION, validateLabelWindow } from '../src/ranking-labels.js';
import { loadConsultants } from '../src/recommend.js';
import { loadShadowModel } from '../src/shadow-rank.js';
import { readFeatureSnapshot } from '../src/ltr-features.js';
import { ndcgAtK, RANKING_METRIC_VERSION } from '../src/ranking-metrics.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const RUNS = Math.max(1, Number(arg('runs', '5')) || 5);

export function evaluate(db, {
  runs = RUNS, consultant_ids = null, shadowModel = null, cutoffAt, windowDays,
} = {}) {
  const labelWindow = validateLabelWindow({ cutoffAt, windowDays });
  const runLimit = Math.max(1, Number(runs) || RUNS);
  const cids = consultant_ids || loadConsultants(db).map((c) => c.consultant_id);
  const groups = [];
  for (const cid of cids) {
    const runRows = db.prepare(`SELECT run_id, created_at FROM decision_runs
      WHERE consultant_id=? AND status='COMPLETED' ORDER BY created_at DESC LIMIT ?`).all(cid, runLimit);
    for (const r of runRows) {
      const items = labelsForRunAt(db, cid, r.run_id, labelWindow);
      if (items.length) groups.push({ consultant_id: cid, run_id: r.run_id, created_at: r.created_at, items });
    }
  }
  const per = [];
  for (const g of groups) {
    // 影子对照（§7 阶段二）：模型分重排同批候选算 NDCG@10，与规则 rank 对照
    if (shadowModel) {
      const candidates = g.items.map((it) => {
        const rec = db.prepare(`SELECT feature_snapshot_json
          FROM recommendations WHERE run_id=? AND project_id=?`).get(g.run_id, it.project_id);
        const snapshot = readFeatureSnapshot(rec?.feature_snapshot_json);
        return { item: it, snapshot };
      });
      const invalid = candidates.filter((row) => !row.snapshot.ok);
      if (invalid.length) {
        g.shadow_excluded_reason = invalid[0].snapshot.reason;
        g.shadow_excluded_count = invalid.length;
      } else {
        const scored = candidates.map(({ item, snapshot }) => ({
          ...item, shadow: shadowModel.score(snapshot.features),
        })).sort((a, b) => b.shadow - a.shadow);
        g.shadow_ndcg_at_10 = ndcgAtK(scored, 10);
      }
    }
    const labeled = g.items.filter((i) => i.label !== null);
    const valuable = labeled.filter((i) => i.label >= 2);
    const recall50 = valuable.length
      ? valuable.filter((i) => i.rank <= 50).length / valuable.length : null;
    const top10 = g.items.slice(0, 10).filter((i) => i.label !== null);
    per.push({
      consultant_id: g.consultant_id, run_id: g.run_id, created_at: g.created_at,
      shadow_ndcg_at_10: g.shadow_ndcg_at_10 ?? null,
      shadow_excluded_reason: g.shadow_excluded_reason ?? null,
      shadow_excluded_count: g.shadow_excluded_count ?? 0,
      candidates: g.items.length, labeled: labeled.length, valuable: valuable.length,
      label_coverage: g.items.length ? labeled.length / g.items.length : null,
      recall_at_50: recall50,
      ndcg_at_10: ndcgAtK(g.items, 10),
      precision_at_10: top10.length ? top10.filter((i) => i.label >= 2).length / top10.length : null,
    });
  }
  const avg = (key) => {
    const xs = per.map((r) => r[key]).filter((x) => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const sampleStatus = {};
  const negativeReasons = {};
  for (const group of groups) {
    for (const item of group.items) {
      const key = `${item.status}:${item.reason}`;
      sampleStatus[key] = (sampleStatus[key] || 0) + 1;
      for (const reason of item.negative_reason_codes || []) {
        negativeReasons[reason] = (negativeReasons[reason] || 0) + 1;
      }
    }
  }
  return {
    generated_at: new Date().toISOString(), metric_version: RANKING_METRIC_VERSION,
    label_version: RANKING_LABEL_VERSION, label_window_days: labelWindow.windowDays,
    label_cutoff_at: labelWindow.cutoffAt, sample_status: sampleStatus,
    negative_reason_counts: negativeReasons,
    groups: per.length,
    metrics: {
      recall_at_50: avg('recall_at_50'), ndcg_at_10: avg('ndcg_at_10'),
      precision_at_10: avg('precision_at_10'), label_coverage: avg('label_coverage'),
      ...(shadowModel ? { shadow_ndcg_at_10: avg('shadow_ndcg_at_10') } : {}),
    },
    note: '时间切分口径：标签窗口从真实曝光开始，只纳入窗口内发生且截点前收到、'
      + '明确关联本推荐项的事实；未曝光、未成熟、缺历史时间和未知结果分别报告。'
      + '未知标签保留预测位置且不当作 0，IDCG 取同组全部已知标签。',
    groups_detail: per,
  };
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
  const shadowPath = arg('shadow', null);
  const shadowModel = shadowPath ? loadShadowModel(shadowPath) : null;
  if (shadowPath && !shadowModel) console.error(`[shadow] 模型不可用：${shadowPath}`);
  const out = evaluate(db, { runs: RUNS, shadowModel, ...labelWindow });
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`排序组: ${out.groups}（近 ${RUNS} 轮/顾问）`);
    for (const [k, v] of Object.entries(out.metrics)) {
      console.log(`  ${k}: ${v === null ? '样本不足' : (v * 100).toFixed(1) + '%'}`);
    }
    console.log(`\n口径说明: ${out.note}`);
  }
}
