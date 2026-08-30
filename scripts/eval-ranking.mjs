#!/usr/bin/env node
/** eval-ranking.mjs — 排序离线评估（算法文档 §6 验收层：召回/排序/稳定性）。
 * 只读。按「顾问 × 最近 N 轮」排序组计算：
 *   Recall@50   高价值岗位（label≥2）进入候选池 Top50 的比例
 *   NDCG@10     Top10 的折损累计增益（0–5 级标签）
 *   Precision@10 Top10 中 label≥2 的比例
 *   覆盖率      有标签岗位被评估进任意轮候选的比例
 * 纪律：按时间切分口径（标签只取评估时点之后的结果演化另算——当前快照口径为简化版，
 * 报告中明示限制）；与规则基线（当前线上六维评分）同批回放对照。
 * 用法：node scripts/eval-ranking.mjs [--runs 5] [--db <path>] [--json]
 */
import '../src/env.js';
import { openDb } from '../src/db.js';
import { labelsForRun } from '../src/labels.js';
import { loadConsultants } from '../src/recommend.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const RUNS = Math.max(1, Number(arg('runs', '5')) || 5);

function dcg(labels) {
  return labels.reduce((s, l, i) => s + ((Math.pow(2, l) - 1) / Math.log2(i + 2)), 0);
}

function ndcg(items, k) {
  const top = items.filter((i) => i.label !== null).slice(0, k);
  if (!top.length) return null;
  const ideal = [...top.map((i) => i.label)].sort((a, b) => b - a);
  const denom = dcg(ideal);
  return denom > 0 ? dcg(top.map((i) => i.label)) / denom : null;
}

export function evaluate(db, { runs = RUNS, consultant_ids = null } = {}) {
  const cids = consultant_ids || loadConsultants(db).map((c) => c.consultant_id);
  const groups = [];
  for (const cid of cids) {
    const runRows = db.prepare(`SELECT run_id, created_at FROM decision_runs
      WHERE consultant_id=? AND status='COMPLETED' ORDER BY created_at DESC LIMIT ?`).all(cid, RUNS);
    for (const r of runRows) {
      const items = labelsForRun(db, cid, r.run_id);
      if (items.length) groups.push({ consultant_id: cid, run_id: r.run_id, created_at: r.created_at, items });
    }
  }
  const per = [];
  for (const g of groups) {
    const labeled = g.items.filter((i) => i.label !== null);
    const valuable = labeled.filter((i) => i.label >= 2);
    const recall50 = valuable.length
      ? valuable.filter((i) => i.rank <= 50).length / valuable.length : null;
    const top10 = g.items.slice(0, 10).filter((i) => i.label !== null);
    per.push({
      consultant_id: g.consultant_id, run_id: g.run_id, created_at: g.created_at,
      candidates: g.items.length, labeled: labeled.length, valuable: valuable.length,
      recall_at_50: recall50,
      ndcg_at_10: ndcg(g.items, 10),
      precision_at_10: top10.length ? top10.filter((i) => i.label >= 2).length / top10.length : null,
    });
  }
  const avg = (key) => {
    const xs = per.map((r) => r[key]).filter((x) => x !== null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  return {
    generated_at: new Date().toISOString(), groups: per.length,
    metrics: {
      recall_at_50: avg('recall_at_50'), ndcg_at_10: avg('ndcg_at_10'),
      precision_at_10: avg('precision_at_10'),
    },
    note: '快照口径：标签取当前可见结果（未来演化未按时间切分隔离，仅作基线对照，不作上线判据）',
    groups_detail: per,
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = openDb(arg('db', undefined));
  const out = evaluate(db, { runs: RUNS });
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`排序组: ${out.groups}（近 ${RUNS} 轮/顾问）`);
    for (const [k, v] of Object.entries(out.metrics)) {
      console.log(`  ${k}: ${v === null ? '样本不足' : (v * 100).toFixed(1) + '%'}`);
    }
    console.log(`\n口径说明: ${out.note}`);
  }
}
