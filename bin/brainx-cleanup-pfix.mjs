#!/usr/bin/env node
/** brainx-cleanup-pfix.mjs — P-FIX 占位行清理与合并（幂等；默认 dry-run，--apply 才落库）。
 *
 * 三类处理：
 *  A. 有真身（source_url=ttc://job/<真ID> 且真ID在 job_facts）：
 *     迁移用户数据（decision_events / openmai_results / job_memberships / job_messages 归因）
 *     到真身行 → 删 P-FIX 行与其 recommendations（重跑推荐会生成真身推荐）。
 *  B. 真身缺失（source_url=ttc://job/<X> 但 X 不在库）：保留——TTC 里可能仍存在（可找人）。
 *  C. 无源（source_url 为 feishu://base 或空）：删 job_facts 行 + recommendations + job_memberships
 *     + openmai_results；decision_events 账本保留（审计事实源，孤儿事件不影响展示）。
 *
 * 用法：node bin/brainx-cleanup-pfix.mjs [--apply]
 */
import { openDb } from '../src/db.js';

const APPLY = process.argv.includes('--apply');
const db = openDb(process.env.BRAINX_DB || new URL('../data/brainx.db', import.meta.url).pathname);

const pfixRows = db.prepare("SELECT project_id, source_url FROM job_facts WHERE project_id LIKE 'P-FIX-%'").all();
const realIds = new Set(db.prepare("SELECT project_id FROM job_facts WHERE project_id NOT LIKE 'P-FIX-%'").all().map((r) => r.project_id));

const migrate = [];   // A：{pfix, real, migrated: {events, results, memberships, messages}}
const keep = [];      // B：真身缺失，保留
const drop = [];      // C：无源，删除

for (const row of pfixRows) {
  const m = String(row.source_url || '').match(/^ttc:\/\/job\/(.+)$/);
  if (m) {
    const real = m[1].trim();
    if (realIds.has(real)) migrate.push({ pfix: row.project_id, real });
    else keep.push({ pfix: row.project_id, real, note: '真身不在库（保留：TTC 可能仍存在）' });
  } else {
    drop.push({ pfix: row.project_id, source: row.source_url || '(空)' });
  }
}

console.log(`P-FIX 总数：${pfixRows.length}`);
console.log(`  A 有真身（迁移+删）：${migrate.length}`);
console.log(`  B 真身缺失（保留）：${keep.length}`);
console.log(`  C 无源（删除）：    ${drop.length}`);
if (keep.length) for (const k of keep.slice(0, 5)) console.log(`    保留示例：${k.pfix} → ${k.real}`);
if (drop.length) for (const d of drop.slice(0, 5)) console.log(`    删除示例：${d.pfix} · ${d.source.slice(0, 50)}`);

if (!APPLY) {
  console.log('\n（dry-run，未落库。加 --apply 执行。）');
  process.exit(0);
}

const counts = { events: 0, results: 0, memberships: 0, messages: 0, recsDeleted: 0, rowsDeleted: 0 };
const BATCH = 50; // 分批小事务：巨型单事务在 239MB 库上会被宿主超时杀掉（实测 SIGKILL 后整体回滚）

const runBatch = (fn) => { db.exec('BEGIN'); try { fn(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } };

const cleanOne = ({ pfix, real, withMigrate }) => {
  if (withMigrate) {
    db.prepare(`DELETE FROM openmai_results WHERE project_id=? AND consultant_id IN
      (SELECT consultant_id FROM openmai_results WHERE project_id=?)`).run(real, pfix);
    counts.results += db.prepare('UPDATE openmai_results SET project_id=? WHERE project_id=?').run(real, pfix).changes;
    counts.events += db.prepare('UPDATE decision_events SET project_id=? WHERE project_id=?').run(real, pfix).changes;
    db.prepare(`DELETE FROM job_memberships WHERE project_id=? AND consultant_id IN
      (SELECT consultant_id FROM job_memberships WHERE project_id=?)`).run(real, pfix);
    counts.memberships += db.prepare('UPDATE job_memberships SET project_id=? WHERE project_id=?').run(real, pfix).changes;
    counts.messages += db.prepare('UPDATE job_messages SET matched_project_id=? WHERE matched_project_id=?').run(real, pfix).changes;
  }
  counts.recsDeleted += db.prepare('DELETE FROM recommendations WHERE project_id=?').run(pfix).changes;
  // FK 引用表清理（decision_events 账本无 FK，保留审计历史）
  for (const t of ['job_memberships', 'job_outcomes', 'cockpit_facts', 'job_classifications',
                   'job_occupancy', 'manual_fact_overrides', 'fact_override_events', 'openmai_results']) {
    db.prepare(`DELETE FROM ${t} WHERE project_id=?`).run(pfix);
  }
  counts.rowsDeleted += db.prepare('DELETE FROM job_facts WHERE project_id=?').run(pfix).changes;
};

try {
  for (let i = 0; i < migrate.length; i += BATCH) {
    const batch = migrate.slice(i, i + BATCH);
    runBatch(() => { for (const m of batch) cleanOne({ ...m, withMigrate: true }); });
    process.stdout.write(`\r迁移+删 ${Math.min(i + BATCH, migrate.length)}/${migrate.length}`);
  }
  for (let i = 0; i < drop.length; i += BATCH) {
    const batch = drop.slice(i, i + BATCH);
    runBatch(() => { for (const d of batch) cleanOne({ pfix: d.pfix, withMigrate: false }); });
    process.stdout.write(`\r无源删除 ${Math.min(i + BATCH, drop.length)}/${drop.length}`);
  }
} catch (e) {
  console.error(`\n❌ 批次失败（已完成的批次保留，失败批回滚）：${e.message}`);
  process.exit(1);
}

console.log('\n✅ 清理完成（事务已提交）：');
console.log(`  迁移：决策事件 ${counts.events} · 找人结果 ${counts.results} · 项目关系 ${counts.memberships} · 消息归因 ${counts.messages}`);
console.log(`  删除：P-FIX 行 ${counts.rowsDeleted} · 推荐快照 ${counts.recsDeleted}`);
console.log(`  库内剩余 P-FIX：${db.prepare("SELECT COUNT(*) n FROM job_facts WHERE project_id LIKE 'P-FIX-%'").get().n}（均为真身缺失保留项）`);
