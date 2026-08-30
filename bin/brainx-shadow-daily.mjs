#!/usr/bin/env node
/** brainx-shadow-daily.mjs — 影子对照日报（算法文档 §7 阶段二收尾）。
 * 每日一次：跑规则 vs LambdaMART 影子对照评估，输出：
 *   ① NDCG@10 / Recall@50 / Precision@10（规则 vs 影子）
 *   ② 分歧 TopN：每顾问最新一轮中，影子分排序与规则 rank 位移最大的职位
 *     （位移 = |shadow_rank - rule_rank|，附双向分数与当前标签，供人工复核）
 * 只读。写 data/shadow-daily-latest.json 供巡检/前端调用；--json 直出。
 * 用法：node bin/brainx-shadow-daily.mjs [--runs 5] [--model data/ltr-model.json] [--top 5]
 */
import '../src/env.js';
import { writeFileSync } from 'node:fs';
import { openDb, now } from '../src/db.js';
import { evaluate } from '../scripts/eval-ranking.mjs';
import { loadShadowModel } from '../src/shadow-rank.js';
import { featuresOf } from '../src/ltr-features.js';
import { loadConsultants } from '../src/recommend.js';
import { labelFor } from '../src/labels.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };

/** 单顾问最新一轮的分歧 TopN。 */
export function divergenceTopN(db, model, consultant_id, { top = 5 } = {}) {
  const run = db.prepare(`SELECT run_id, created_at FROM decision_runs
    WHERE consultant_id=? AND status='COMPLETED' ORDER BY created_at DESC LIMIT 1`).get(consultant_id);
  if (!run) return null;
  const recs = db.prepare(`SELECT project_id, rank, action, score, evidence_coverage, breakdown_json
    FROM recommendations WHERE run_id=? AND consultant_id=? ORDER BY rank LIMIT 50`)
    .all(run.run_id, consultant_id);
  const scored = [];
  for (const r of recs) {
    const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(r.project_id);
    const feat = featuresOf({ ...r, breakdown: JSON.parse(r.breakdown_json || '{}'), job },
      { nowIso: run.created_at });
    scored.push({ ...r, shadow: model.score(feat) });
  }
  const shadowOrder = [...scored].sort((a, b) => b.shadow - a.shadow)
    .map((r, i) => [r.project_id, i + 1]);
  const shadowRank = Object.fromEntries(shadowOrder);
  return {
    consultant_id, run_id: run.run_id, created_at: run.created_at,
    top: scored.map((r) => ({ ...r, shadow_rank: shadowRank[r.project_id],
                              delta: Math.abs(shadowRank[r.project_id] - r.rank) }))
      .sort((a, b) => b.delta - a.delta).slice(0, top)
      .map((r) => ({ project_id: r.project_id, rule_rank: r.rank, shadow_rank: r.shadow_rank,
                     delta: r.delta, rule_score: r.score, shadow_score: Number(r.shadow.toFixed(3)),
                     action: r.action, label: labelFor(db, consultant_id, r.project_id) })),
  };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = openDb(arg('db', undefined));
  const modelPath = arg('model', 'data/ltr-model.json');
  const model = loadShadowModel(modelPath);
  if (!model) { console.error(`影子模型不可用：${modelPath}（先跑 bin/brainx-ltr-export.mjs + scripts/train_ltr.py）`); process.exit(2); }
  const runs = Math.max(1, Number(arg('runs', '5')) || 5);
  const top = Math.max(1, Number(arg('top', '5')) || 5);
  const ev = evaluate(db, { runs, shadowModel: model });
  const divergence = loadConsultants(db)
    .map((c) => divergenceTopN(db, model, c.consultant_id, { top }))
    .filter(Boolean);
  const report = { generated_at: now(), model: { trained_at: model.trained_at, rows: model.rows },
                   metrics: ev.metrics, divergence, note: ev.note };
  writeFileSync('data/shadow-daily-latest.json', JSON.stringify(report, null, 2));
  if (process.argv.includes('--json')) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }
  console.log(`影子对照日报 ${report.generated_at}`);
  for (const [k, v] of Object.entries(ev.metrics)) {
    console.log(`  ${k}: ${v === null ? '样本不足' : (v * 100).toFixed(1) + '%'}`);
  }
  for (const d of divergence) {
    if (!d.top.length) continue;
    console.log(`\n[${d.consultant_id}] 分歧 Top${d.top.length}（run ${d.run_id.slice(0, 8)}）:`);
    for (const t of d.top) {
      console.log(`  ${t.project_id} 规则#${t.rule_rank} → 影子#${t.shadow_rank} (Δ${t.delta}) label=${t.label ?? '-'}`);
    }
  }
  console.log('\n报告: data/shadow-daily-latest.json');
}
