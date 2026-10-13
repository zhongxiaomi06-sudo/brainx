#!/usr/bin/env node
/** sourcing-candidates-backfill.mjs — specs/036 一次性回填：把历史 done 结果拆行落 sourcing_candidates。
 *  生产运行（ECS，brainx 用户）：node bin/sourcing-candidates-backfill.mjs
 *  幂等：主键 (search_key, consultant_id, round, ref) 冲突时只刷新快照字段。 */
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { storeSourcingCandidates } from '../src/sourcing-candidates.js';

const db = new DatabaseSync(process.env.BRAINX_DB || 'data/brainx.db');
const rows = db.prepare(`SELECT project_id, consultant_id, task_id, search_round
  FROM openmai_results WHERE status='done' AND result_text IS NOT NULL`).all();
console.log(`done 任务 ${rows.length} 条`);
let stored = 0, failed = 0;
for (const row of rows) {
  try {
    const n = storeSourcingCandidates(db, { projectId: row.project_id,
      consultantId: row.consultant_id, taskId: row.task_id });
    stored += n;
  } catch (e) { failed += 1; console.error(`✗ ${row.project_id} r${row.search_round}: ${e.message}`); }
}
console.log(`拆行入库 ${stored} 行，失败 ${failed} 条`);
process.exit(failed > 0 ? 2 : 0);
