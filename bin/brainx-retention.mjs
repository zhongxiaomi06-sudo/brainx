#!/usr/bin/env node
/** brainx-retention — 推荐冻结 retention 清理（2026-08-24，db-growth-governance-proposal §B）。
 *
 * 背景：bridge 每 180s 无条件全量冻结，recommendations 5 天膨胀到 166 万行，
 * 磁盘 ~0.6G/天 增长。本脚本按提案规则一次性 + 周度例行清理。
 *
 * 保留规则（命中任一即保留）：
 *   1. rank <= 20（真正曝光过的部分，打标/评估用）；
 *   2. 有信号关联的 （顾问， 职位）：非 RECOMMENDED 事件 / job_outcomes / recommendation_feedback；
 *   3. 每顾问每日最早一轮的全量（诊断统计基线轮）；
 *   4. 每顾问最近 5 轮全量（近期复盘）。
 * 级联：recommendations 删空后的孤儿 decision_runs（COMPLETED）删除；
 *       RECOMMENDED 事件若 decision_id 指向已删行则一并删除。
 *
 * 默认 --dry-run（只出计数对照表）；--apply 才真正删除。删除前请先 .backup 留档。
 * 用法：node bin/brainx-retention.mjs [--apply] [--db <path>]
 */
import '../src/env.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const apply = process.argv.includes('--apply');
const KEEP_RUNS = 5;

/** 计算保留/删除计数（dry-run 与 apply 共用同一套规则，单一口径）。 */
export function plan(db) {
  db.exec(`
    CREATE TEMP TABLE keep_runs AS
      SELECT run_id FROM (
        SELECT run_id, consultant_id,
               ROW_NUMBER() OVER (PARTITION BY consultant_id ORDER BY created_at DESC) recent_rank,
               ROW_NUMBER() OVER (PARTITION BY consultant_id, substr(created_at,1,10) ORDER BY created_at ASC) day_rank
        FROM decision_runs)
      WHERE recent_rank <= ${KEEP_RUNS} OR day_rank = 1;
    CREATE TEMP TABLE signal_pairs AS
      SELECT DISTINCT actor AS c, project_id AS p FROM decision_events WHERE event_type != 'RECOMMENDED'
      UNION SELECT consultant_id, project_id FROM job_outcomes
      UNION SELECT consultant_id, project_id FROM recommendation_feedback;
    CREATE TEMP TABLE delete_rows AS
      SELECT r.decision_id FROM recommendations r
      WHERE r.rank > 20
        AND r.run_id NOT IN (SELECT run_id FROM keep_runs)
        AND NOT EXISTS (SELECT 1 FROM signal_pairs s WHERE s.c = r.consultant_id AND s.p = r.project_id);
  `);
  const one = (sql) => db.prepare(sql).get();
  return {
    recommendations_total: one('SELECT COUNT(*) n FROM recommendations').n,
    recommendations_delete: one('SELECT COUNT(*) n FROM delete_rows').n,
    recommendations_keep: one('SELECT COUNT(*) n FROM recommendations').n - one('SELECT COUNT(*) n FROM delete_rows').n,
    keep_breakdown: {
      rank_le_20: one('SELECT COUNT(*) n FROM recommendations WHERE rank<=20').n,
      signal_pairs: one('SELECT COUNT(*) n FROM signal_pairs').n,
      keep_runs: one('SELECT COUNT(*) n FROM keep_runs').n,
    },
    orphan_runs_delete: one(`SELECT COUNT(*) n FROM decision_runs dr
      WHERE dr.status='COMPLETED'
        AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.run_id = dr.run_id
                        AND r.decision_id NOT IN (SELECT decision_id FROM delete_rows))
        AND EXISTS (SELECT 1 FROM recommendations r2 WHERE r2.run_id = dr.run_id)`).n,
    recommended_events_delete: one(`SELECT COUNT(*) n FROM decision_events
      WHERE event_type='RECOMMENDED' AND decision_id IN (SELECT decision_id FROM delete_rows)`).n,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(arg('db', undefined));
  const report = plan(db);
  if (!apply) {
    console.log(JSON.stringify({ dry_run: true, ...report }, null, 2));
    console.error('[retention] dry-run：确认计数无误后加 --apply 执行（执行前先备份）');
    process.exit(0);
  }
  db.exec('BEGIN');
  const delRecs = db.prepare('DELETE FROM recommendations WHERE decision_id IN (SELECT decision_id FROM delete_rows)').run();
  const delEvents = db.prepare(`DELETE FROM decision_events WHERE event_type='RECOMMENDED'
    AND decision_id IN (SELECT decision_id FROM delete_rows)`).run();
  const delRuns = db.prepare(`DELETE FROM decision_runs WHERE status='COMPLETED'
    AND NOT EXISTS (SELECT 1 FROM recommendations r WHERE r.run_id = decision_runs.run_id)`).run();
  // 方案 A 节流审计行：7 天内的留着可查，更老的清理（纯审计行，无冻结推荐）
  const delSkipped = db.prepare(`DELETE FROM decision_runs WHERE status='SKIPPED_UNCHANGED'
    AND created_at < datetime('now', '-7 days')`).run();
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(JSON.stringify({ dry_run: false, ...report,
    deleted: { recommendations: delRecs.changes, recommended_events: delEvents.changes,
               decision_runs: delRuns.changes, skipped_audit_runs: delSkipped.changes } }, null, 2));
  console.error('[retention] 删除完成。空间回收需另跑 VACUUM（锁库，离线窗执行）：');
  console.error(`  node -e "import('node:sqlite').then(({DatabaseSync})=>{const d=new DatabaseSync(process.env.BRAINX_DB||'data/brainx.db');d.exec('VACUUM');d.close()})"`);
}
