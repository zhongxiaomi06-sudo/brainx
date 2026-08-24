#!/usr/bin/env node
/** diagnose-policy — 六维打分框架无监督诊断（2026-08-24 Phase ②，只读）。
 *
 * 不需要任何行为标签，从冻结的 recommendations.breakdown_json 诊断框架本身：
 *   1. 维度两两 Pearson 相关矩阵 —— 验证「方向 vs 历史相似度」信号冗余（corr>0.8 建议合并）
 *   2. 分数分布（全量/Top20/按 band）与天花板效应（Top20 score≥90 占比）
 *   3. coverage 分布与冷启动路径使用频率（各维 missing 占比）
 *   4. 探索位轮换率：每顾问每 7 天 Top20 独立职位对数、探索满分职位进榜率
 *   5. 基于规则的调权建议（人工审，不自动改权重）
 *
 * 只读纪律：DatabaseSync(path, { readOnly: true }) 直连，不走 openDb
 * （openDb 会写 WAL/schema_migrations/补种花名册）。
 *
 * 用法：node scripts/diagnose-policy.mjs [--db data/brainx-cloud.db] [--json]
 */
import '../src/env.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const DIMS = ['direction', 'activity', 'similarity', 'capacity', 'outcomes', 'exploration'];

// —— 纯统计函数（导出供 tests 复用）——
export function makePearsonAcc() {
  return { n: 0, sx: 0, sy: 0, sxy: 0, sx2: 0, sy2: 0 };
}
export function pearsonAdd(acc, x, y) {
  acc.n++; acc.sx += x; acc.sy += y; acc.sxy += x * y; acc.sx2 += x * x; acc.sy2 += y * y;
}
export function pearsonOf(acc) {
  if (acc.n < 3) return null;
  const num = acc.n * acc.sxy - acc.sx * acc.sy;
  const den = Math.sqrt((acc.n * acc.sx2 - acc.sx ** 2) * (acc.n * acc.sy2 - acc.sy ** 2));
  return den === 0 ? null : Math.round((num / den) * 1000) / 1000;
}
export function buckets(values, edges) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const v of values) {
    let i = 0;
    while (i < edges.length && v >= edges[i]) i++;
    counts[i]++;
  }
  return counts;
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/** 主诊断。db 可为只读连接；返回结构化报告（纯读）。 */
export function diagnose(db) {
  const pairAcc = {};
  for (let i = 0; i < DIMS.length; i++) for (let j = i + 1; j < DIMS.length; j++) {
    pairAcc[`${DIMS[i]}|${DIMS[j]}`] = makePearsonAcc();
  }
  const dimMissing = Object.fromEntries(DIMS.map((d) => [d, 0]));
  const dimPresent = Object.fromEntries(DIMS.map((d) => [d, 0]));
  const scoresAll = [], scoresTop20 = [];
  const bandCounts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const coverageVals = [];
  let rows = 0, top20Rows = 0, top20Ge90 = 0, emptyBreakdown = 0;
  const weekly = new Map(); // `${cid}|${week}` → Set(project_id)
  const exploreTop20 = { full: 0, half: 0 };

  const cursor = db.prepare(`SELECT consultant_id, project_id, rank, score, confidence_band,
    evidence_coverage, breakdown_json, created_at FROM recommendations`);
  for (const r of cursor.iterate()) {
    rows++;
    const scores = [];
    if (r.score != null) { scoresAll.push(r.score); coverageVals.push(r.evidence_coverage); }
    if (r.confidence_band in bandCounts) bandCounts[r.confidence_band]++;
    const isTop20 = r.rank <= 20;
    if (isTop20) {
      top20Rows++;
      if (r.score >= 90) top20Ge90++;
      scoresTop20.push(r.score);
      const week = String(r.created_at).slice(0, 10);
      const wk = weekKey(week);
      const key = `${r.consultant_id}|${wk}`;
      if (!weekly.has(key)) weekly.set(key, new Set());
      weekly.get(key).add(r.project_id);
    }
    let bd;
    try { bd = JSON.parse(r.breakdown_json || '[]'); } catch { bd = []; }
    if (!Array.isArray(bd) || !bd.length) { emptyBreakdown++; continue; }
    const vec = {};
    for (const d of bd) {
      if (!DIMS.includes(d.dim)) continue;
      vec[d.dim] = d.score;
      if (d.score == null) dimMissing[d.dim]++; else dimPresent[d.dim]++;
    }
    if (isTop20 && vec.exploration === 100) exploreTop20.full++;
    if (isTop20 && vec.exploration === 50) exploreTop20.half++;
    for (let i = 0; i < DIMS.length; i++) for (let j = i + 1; j < DIMS.length; j++) {
      const a = vec[DIMS[i]], b = vec[DIMS[j]];
      if (a != null && b != null) pearsonAdd(pairAcc[`${DIMS[i]}|${DIMS[j]}`], a, b);
    }
    void scores;
  }

  const correlation = Object.fromEntries(Object.entries(pairAcc).map(([k, acc]) => [k, {
    pearson: pearsonOf(acc), pairs: acc.n,
  }]));
  const weeklyRotation = [...weekly.entries()].map(([k, s]) => {
    const [consultant_id, week] = k.split('|');
    return { consultant_id, week_start: week, unique_top20_jobs: s.size };
  }).sort((a, b) => a.consultant_id.localeCompare(b.consultant_id) || a.week_start.localeCompare(b.week_start));

  const edges = [55, 65, 75, 85, 90, 95];
  const report = {
    rows_scanned: rows,
    empty_breakdown_rows: emptyBreakdown,
    correlation,
    score_distribution: {
      all: { buckets: buckets(scoresAll, edges), edges, n: scoresAll.length },
      top20: { buckets: buckets(scoresTop20, edges), edges, n: scoresTop20.length },
      by_band: bandCounts,
      top20_score_ge_90_pct: pct(top20Ge90, top20Rows),
    },
    coverage: {
      buckets: buckets(coverageVals, [0.5, 0.6, 0.7, 0.85]), edges: [0.5, 0.6, 0.7, 0.85],
      mean: coverageVals.length ? Math.round((coverageVals.reduce((s, v) => s + v, 0) / coverageVals.length) * 100) / 100 : null,
    },
    dim_missing_pct: Object.fromEntries(DIMS.map((d) => [d, pct(dimMissing[d], dimMissing[d] + dimPresent[d])])),
    exploration: {
      top20_exploration_100: exploreTop20.full, top20_exploration_50: exploreTop20.half,
      weekly_top20_rotation: weeklyRotation,
    },
    verdicts: [],
  };
  // —— 规则判定（阈值写死，人工审）——
  const dirSim = correlation['direction|similarity'];
  if (dirSim?.pearson != null && dirSim.pearson > 0.8) {
    report.verdicts.push({ id: 'REDUNDANT_DIRECTION_SIMILARITY', level: 'high',
      finding: `direction 与 similarity 相关系数 ${dirSim.pearson}（n=${dirSim.pairs}）——两维实为同一信号，合计吃了 40% 权重`,
      suggestion: '合并为一个「文本匹配」维（25%），释放 15% 权重给行为反馈或结果维' });
  }
  if (report.score_distribution.top20_score_ge_90_pct > 50) {
    report.verdicts.push({ id: 'CEILING_EFFECT', level: 'medium',
      finding: `Top20 中 ${report.score_distribution.top20_score_ge_90_pct}% 分数 ≥90，头部无区分度`,
      suggestion: '活跃度分档改连续衰减、优先级加成降权，或排序键引入 coverage 之外的二级区分信号' });
  }
  if ((report.dim_missing_pct.outcomes ?? 0) > 80) {
    report.verdicts.push({ id: 'OUTCOMES_STARVED', level: 'high',
      finding: `outcomes 维 ${report.dim_missing_pct.outcomes}% 行缺失——历史结果维名存实亡`,
      suggestion: '先把 outcome 回写修通（brainx-outcome-import 补录存量），再谈该维权重' });
  }
  const rot = weeklyRotation.filter((w) => w.unique_top20_jobs <= 5).length;
  if (weeklyRotation.length && rot / weeklyRotation.length > 0.5) {
    report.verdicts.push({ id: 'STALE_TOP20', level: 'medium',
      finding: `${rot}/${weeklyRotation.length} 个「顾问×周」Top20 独立职位 ≤5 个——榜单固化，探索位未有效轮换`,
      suggestion: '探索位独立成每日 1-2 个坑位（不占主榜），或提高 exploration 权重至真正影响排序' });
  }
  return report;
}

/** 'YYYY-MM-DD' → 所在周周一（ISO 周）。 */
export function weekKey(day) {
  const d = new Date(day + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 周一=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dbPath = arg('db', process.env.BRAINX_DB
    || (existsSync(join(ROOT, 'data', 'brainx-cloud.db')) ? join(ROOT, 'data', 'brainx-cloud.db')
                                                          : join(ROOT, 'data', 'brainx.db')));
  if (!existsSync(dbPath)) { console.error(`找不到库：${dbPath}（--db 指定，或先 npm run data:pull）`); process.exit(2); }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  console.error(`[diagnose] 读取 ${dbPath}（只读）…`);
  const report = diagnose(db);
  console.log(JSON.stringify(report, null, 2));
  console.error(`[diagnose] ${report.rows_scanned} 行 · direction|similarity r=${report.correlation['direction|similarity']?.pearson} · Top20≥90: ${report.score_distribution.top20_score_ge_90_pct}% · verdicts: ${report.verdicts.map((v) => v.id).join(', ') || '无'}`);
}
