#!/usr/bin/env node
/** 补偿投递：把 2026-10-15 回填落库的 supermai 合成键改成真实 project_id，
 *  让 enqueueOpenmaiDeliveries 的 INNER JOIN project_launches 能匹配上，
 *  由 worker 投递回群（不重复付费，只改关联字段）。
 *
 *  用法（ECS brainx 用户）：
 *    /usr/bin/node /opt/brainx/bin/brainx-redeliver-relink.mjs [--dry-run]
 */
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

const dryRun = process.argv.includes('--dry-run');
const db = openDb('/opt/brainx/data/brainx.db');

// task_id -> 真实 project_id（来自 2026-10-15 回填日志 #1~#15 的 proj 映射）
const MAP = {
  sm_c3c7a44c: 'JBGTFRT',
  sm_186f4523: 'JC6JZPU',
  sm_8885fa95: 'JSV8VOH',
  sm_8f8a070a: 'JBZ1NSL',
  sm_d6a203ec: 'JH46A56',
  sm_53ac68d6: 'JTXU1JD',
  sm_e75b945f: 'J27WQBS',
  sm_bafc5d0f: 'J7AKNAL',
  sm_a4dd9183: 'JCDWDEP',
};

console.log(`=== 补偿投递关联修正 ${dryRun ? '[DRY-RUN]' : ''} ===`);

let relinked = 0, skipped = 0, conflict = 0;
for (const [taskId, realProjectId] of Object.entries(MAP)) {
  const row = db.prepare(`SELECT task_id, project_id, consultant_id, status,
    length(result_text) rt_len FROM openmai_results WHERE task_id=?`).get(taskId);
  if (!row) { console.log(`  ${taskId}: ❌ 无记录`); skipped++; continue; }

  // 真实 project_id 必须存在 project_launches（否则改了也投递不了）
  const launch = db.prepare(`SELECT launch_id, chat_id FROM project_launches
    WHERE project_id=? AND status='READY'`).get(realProjectId);
  if (!launch) {
    console.log(`  ${taskId}: ❌ ${realProjectId} 无 READY 项目群，跳过`);
    skipped++; continue;
  }

  // 目标主键 (realProjectId, consultant_id) 是否已被占用
  const occupied = db.prepare(`SELECT task_id, status, started_at,
    length(result_text) rt_len FROM openmai_results
    WHERE project_id=? AND consultant_id=?`).get(realProjectId, row.consultant_id);
  if (occupied) {
    // 占用者无有效结果（僵尸 running >1h，或 failed 且无 result_text）→ 迁到 zombie 键释放主键
    const staleMs = Date.now() - Date.parse(occupied.started_at || 0);
    const isZombie = (occupied.status === 'running' && staleMs > 3600_000);
    const isEmptyFailure = (occupied.status === 'failed' && !occupied.rt_len);
    if (isZombie || isEmptyFailure) {
      const zombieKey = `supermai:zombie:${occupied.task_id}`;
      const why = isZombie ? `僵尸 running（${Math.round(staleMs/60000)} 分钟）` : 'failed 且无有效结果';
      console.log(`  ${taskId}: 占用者 ${occupied.task_id} 是 ${why} → 迁到 ${zombieKey}`);
      if (!dryRun) {
        db.prepare(`UPDATE openmai_results SET project_id=? WHERE task_id=?`)
          .run(zombieKey, occupied.task_id);
      }
    } else {
      console.log(`  ${taskId}: ⚠️ ${realProjectId}/${row.consultant_id} 已被 ${occupied.task_id}（${occupied.status}, rt_len=${occupied.rt_len}）占用，跳过`);
      conflict++; continue;
    }
  }

  console.log(`  ${taskId}: ${row.project_id} → ${realProjectId} (${row.status}, rt_len=${row.rt_len}, chat=${launch.chat_id})`);
  if (!dryRun) {
    db.prepare(`UPDATE openmai_results SET project_id=? WHERE task_id=?`).run(realProjectId, taskId);
    // 同步修正事件表里的 idem_key（保持审计一致）
    db.prepare(`UPDATE workflow_event_log SET idem_key=REPLACE(idem_key, ?, ?)
      WHERE idem_key LIKE ?`).run(row.project_id, realProjectId, `%${row.project_id}%`);
    relinked++;
  }
}

console.log(`\n=== 汇总 ===`);
console.log(`改关联 relinked: ${relinked}`);
console.log(`主键冲突 conflict: ${conflict}`);
console.log(`跳过 skipped: ${skipped}`);
if (!dryRun && relinked > 0) {
  console.log(`\n✅ 已修正 ${relinked} 条。worker 下次跑 enqueueOpenmaiDeliveries 会入队投递回群。`);
  console.log(`   可手动触发投递：观察 openmai_deliveries 新增 PENDING 记录。`);
}
db.close();
