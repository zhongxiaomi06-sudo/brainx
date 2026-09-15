#!/usr/bin/env node
/** brainx-talent-tag-backfill.mjs — 人才标签回填（facts 技能 + summary 意向）。
 * 默认 dry-run（零写入，只打印报告）；--write 才落 RDS。
 * 用法：
 *   node bin/brainx-talent-tag-backfill.mjs [--write] [--talent <id>] [--limit 1000]
 * 凭证：RDS 走 src/db.js withMysql 的 BRAINX_MYSQL_* env 约定（.env，不打印秘密）。
 */
import '../src/env.js';
import { closeMysql } from '../src/db.js';
import { runTalentTagBackfill } from '../src/talent-tag-backfill.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };

const dryRun = !process.argv.includes('--write');
const talentId = arg('talent', undefined);
const limit = Number(arg('limit', 1000));

try {
  const report = await runTalentTagBackfill({ dryRun, talentId, limit });
  console.log(`[talent-tag-backfill] ${report.dry_run ? 'DRY-RUN（零写入）' : 'WRITE（已落库）'} `
    + `ran_at=${report.ran_at} 扫描=${report.talents_scanned} 待打标=${report.talents_to_tag}`
    + `（含事实技能 ${report.talents_with_fact_skills} 人）`);
  console.log(`  将挂标签：skill 链接=${report.skill_tag_links} intention 链接=${report.intention_tag_links}`
    + ` 去重标签名=${report.distinct_tag_names}`);
  for (const s of report.samples) {
    console.log(`  - talent#${s.talent_id} ${s.name ?? ''} skill=[${s.skill.join(',')}] intention=[${s.intention.join(',')}]`);
  }
  if (report.written) {
    console.log(`  已写入：新增 tag=${report.written.tag_rows} 新增 talent_tag=${report.written.talent_tag_rows}`);
  }
  if (dryRun) console.log('[talent-tag-backfill] dry-run 未写入；加 --write 落库。');
} finally {
  await closeMysql();
}
