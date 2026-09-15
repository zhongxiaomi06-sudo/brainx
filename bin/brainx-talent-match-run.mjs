#!/usr/bin/env node
/** brainx-talent-match-run.mjs — 人才匹配跑批（预计算 candidate 短名单）。
 * 默认 dry-run（零写入，只打印每职位报告）；--write 才落 RDS。
 * 用法：
 *   node bin/brainx-talent-match-run.mjs [--write] [--job <project_id>]
 *     [--limit 20] [--tenant <tenant_id>] [--grantee <consultant_id>]...
 * 凭证：RDS 走 src/db.js withMysql 的 BRAINX_MYSQL_* env 约定（.env，不打印秘密）。
 */
import '../src/env.js';
import { openDb, closeMysql } from '../src/db.js';
import { runTalentMatchRun } from '../src/talent-match-run.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const args = (k) => process.argv.reduce((out, v, i) => (v === '--' + k ? [...out, process.argv[i + 1]] : out), []);

const dryRun = !process.argv.includes('--write');
const jobId = arg('job', undefined);
const limit = Number(arg('limit', 20));
const tenantId = arg('tenant', undefined);
const granteeConsultants = args('grantee');

const db = openDb(arg('db', undefined) || undefined);
try {
  const report = await runTalentMatchRun({ db, jobId, dryRun, limit, tenantId, granteeConsultants });
  console.log(`[talent-match-run] ${report.dry_run ? 'DRY-RUN（零写入）' : 'WRITE（已落库）'} `
    + `tenant=${report.tenant_id} ran_at=${report.ran_at} 人才池=${report.talent_pool_size} `
    + `阈值=${report.threshold} 职位数=${report.jobs.length}`);
  for (const job of report.jobs) {
    console.log(`- ${job.project_id} ${job.company || ''} ${job.role || ''}`.trim()
      + ` 命中=${job.matched_count} 授权顾问=[${job.grantee_consultants.join(',')}]`
      + ` match_run=${job.match_run_id}`);
    for (const t of job.top.slice(0, 5)) {
      console.log(`    #${t.rank} ${t.name} score=${t.score} ref=${t.candidate_ref}`);
    }
    if (job.matched_count > 5) console.log(`    … 其余 ${job.matched_count - 5} 名略`);
    if (job.written) console.log(`    已写入候选=${job.written.candidates} 授权=${job.written.grants}`);
  }
  if (dryRun) console.log('[talent-match-run] dry-run 未写入；加 --write 落库。');
} finally {
  db.close();
  await closeMysql();
}
