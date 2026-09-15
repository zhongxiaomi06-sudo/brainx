/** talent-tag-backfill.test.mjs — 人才标签回填（fake conn，不触网/真 RDS）。
 * 覆盖：dry-run 零写入、write 后 tag/talent_tag 正确、重跑幂等、边界
 * （summary 无 '/'、summary NULL、skills 空、同名多人各自打标）、
 * 以及回填后 talent-match-run 的 loadTalentsWithTags 能读到标签（召回从 0 → 1）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import {
  intentionTagsFromSummary,
  skillTagsFromFact,
  runTalentTagBackfill,
} from '../src/talent-tag-backfill.js';
import { runTalentMatchRun } from '../src/talent-match-run.js';

const T1 = '2026-09-15T03:00:00.000Z';

const TALENTS = [
  { id: 247, name: '信鹏飞', summary: '科大讯飞 / 销售总监', status: 'active' },
  { id: 301, name: '王强', summary: '资深销售主管', status: 'active' },   // 无 '/' → 整条分词
  { id: 302, name: '王五', summary: null, status: 'active' },            // NULL → 跳过
  { id: 389, name: '信鹏飞', summary: null, status: 'active' },          // 同名另一人
  { id: 401, name: '李四', summary: '科大讯飞 / Java 开发工程师', status: 'active' },
];
const FACTS = [
  { talent_id: 247, fact_version_id: 'f247', quality_status: 'READY',
    created_at: '2026-09-10 10:00:00',
    facts_json: JSON.stringify({ skills: [{ name: 'AI产品经理' }, { name: '数据分析' }] }) },
  // talent-match-run 写入的空 skills 新事实：不得遮蔽更早的 reloop 事实
  { talent_id: 389, fact_version_id: 'f389b', quality_status: 'READY',
    created_at: '2026-09-15 09:00:00', facts_json: { skills: [] } },
  { talent_id: 389, fact_version_id: 'f389a', quality_status: 'READY',
    created_at: '2026-09-12 10:00:00', facts_json: { skills: [{ name: '招聘' }] } },
  { talent_id: 301, fact_version_id: 'f301', quality_status: 'READY',
    created_at: '2026-09-15 09:30:00', facts_json: { skills: [] } },
];

function createFakeMysql() {
  const tag = new Map();        // 'name|category' -> {id, name, category}
  const talentTag = new Map();  // 'talent_id|tag_id' -> {talent_id, tag_id, source}
  let tagSeq = 0;
  const attempted = [];
  const tx = { begin: 0, commit: 0, rollback: 0 };
  const tagById = () => new Map([...tag.values()].map((g) => [g.id, g]));

  const conn = {
    attempted, tx,
    async query(sql, params = []) {
      if (/FROM talent ORDER BY id DESC/.test(sql)) {
        return [TALENTS.slice().sort((a, b) => b.id - a.id)];
      }
      if (/FROM talent_tag tt/.test(sql)) {
        const ids = new Set(params[0].map(Number));
        const byId = tagById();
        return [[...talentTag.values()].filter((l) => ids.has(l.talent_id))
          .map((l) => ({ talent_id: l.talent_id, ...pick(byId.get(l.tag_id)) }))];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params = []) {
      if (/INSERT IGNORE INTO talent_tag \(/.test(sql)) {
        attempted.push('talent_tag');
        const [talent_id, tag_id, source] = params;
        const key = `${talent_id}|${tag_id}`;
        if (talentTag.has(key)) return [{ affectedRows: 0 }];
        talentTag.set(key, { talent_id: Number(talent_id), tag_id, source });
        return [{ affectedRows: 1 }];
      }
      if (/INSERT IGNORE INTO tag \(/.test(sql)) {
        attempted.push('tag');
        const key = `${params[0]}|${params[1]}`;
        if (tag.has(key)) return [{ affectedRows: 0 }];
        tag.set(key, { id: ++tagSeq, name: params[0], category: params[1] });
        return [{ affectedRows: 1 }];
      }
      if (/SELECT id FROM tag WHERE name/.test(sql)) {
        const row = tag.get(`${params[0]}|${params[1]}`);
        return [row ? [{ id: row.id }] : []];
      }
      if (/FROM candidate_fact_versions/.test(sql)) {
        let rows = FACTS.filter((f) => f.quality_status === 'READY');
        if (/AND talent_id = \?/.test(sql)) rows = rows.filter((f) => f.talent_id === Number(params[0]));
        return [rows.slice().sort((a, b) => b.created_at.localeCompare(a.created_at)
          || b.fact_version_id.localeCompare(a.fact_version_id))];
      }
      if (/SELECT id, name, summary FROM talent WHERE id/.test(sql)) {
        return [TALENTS.filter((t) => t.id === Number(params[0]))];
      }
      if (/SELECT id, name, summary FROM talent/.test(sql)) {
        return [TALENTS.slice().sort((a, b) => a.id - b.id)];
      }
      throw new Error(`unexpected execute: ${sql}`);
    },
    async beginTransaction() { tx.begin += 1; },
    async commit() { tx.commit += 1; },
    async rollback() { tx.rollback += 1; },
  };
  const pick = (g) => ({ name: g.name, category: g.category });
  const linksFor = (talentId) => {
    const byId = tagById();
    return [...talentTag.values()].filter((l) => l.talent_id === talentId)
      .map((l) => ({ ...pick(byId.get(l.tag_id)), source: l.source }));
  };
  return { conn, mysql: (fn) => fn(conn), tag, talentTag, attempted, tx, linksFor };
}

/** 与 talent-match-run 测试同一 SQLite fixture：唯一 OPEN 活跃职位。 */
function jobFixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  db.prepare(`UPDATE job_facts SET active_state='CLOSED'`).run();
  const job = db.prepare(`SELECT jf.project_id FROM job_facts jf
    JOIN job_memberships jm ON jm.project_id=jf.project_id
    WHERE jm.consultant_id='felix' AND jm.valid_to IS NULL LIMIT 1`).get();
  db.prepare(`UPDATE job_facts SET active_state='OPEN', company='示例科技',
    role='Java 开发工程师', city='上海', pipeline=NULL, raw_json='{}'
    WHERE project_id=?`).run(job.project_id);
  return { db, jobId: job.project_id };
}

test('意向分词口径：最后一个斜杠段；无斜杠用整条；空则跳过', () => {
  assert.deepEqual(intentionTagsFromSummary('科大讯飞 / 销售总监'), ['销售', '售总', '总监']);
  assert.deepEqual(intentionTagsFromSummary('资深销售主管'), ['资深', '深销', '销售', '售主', '主管']);
  assert.deepEqual(intentionTagsFromSummary(null), []);
  assert.deepEqual(intentionTagsFromSummary('公司 /'), ['公司'], '斜杠后为空回退到最后非空段');
  // tag.name varchar(50) 上限：超长技能名在源头截断，INSERT/SELECT 才能对上（真库实证）
  assert.deepEqual(skillTagsFromFact({ skills: [{ name: 'x'.repeat(80) }] }), ['x'.repeat(50)]);
});

test('dry-run（默认）：零写入，报告统计正确', async () => {
  const fake = createFakeMysql();
  const report = await runTalentTagBackfill({ mysql: fake.mysql, now: T1 });
  assert.equal(report.dry_run, true);
  assert.equal(report.talents_scanned, 5);
  assert.equal(report.talents_with_fact_skills, 2, '389 的空 skills 新事实被跳过、取到旧事实');
  assert.equal(report.talents_to_tag, 4, 'summary NULL 且无技能的 302 不打标');
  assert.equal(report.skill_tag_links, 3);
  assert.equal(report.intention_tag_links, 13);
  assert.equal(report.distinct_tag_names, 15);
  assert.equal(report.written, null);
  assert.deepEqual(fake.attempted, [], 'dry-run 不得有任何 INSERT');
  assert.equal(fake.tx.begin, 0);
});

test('write：skill 来自 facts、intention 来自 summary 岗位段，source 分开记账', async () => {
  const fake = createFakeMysql();
  const report = await runTalentTagBackfill({ mysql: fake.mysql, dryRun: false, now: T1 });
  assert.equal(fake.tx.begin, 1);
  assert.equal(fake.tx.commit, 1);
  assert.deepEqual(report.written, { tag_rows: 15, talent_tag_rows: 16 });

  assert.ok(fake.tag.get('AI产品经理|skill'), '技能标签来自 facts_json.skills');
  assert.ok(fake.tag.get('java|intention'), '意向标签来自 summary 岗位段分词');
  const t247 = fake.linksFor(247);
  assert.equal(t247.filter((l) => l.category === 'skill').length, 2);
  assert.equal(t247.filter((l) => l.category === 'intention').length, 3);
  assert.ok(t247.filter((l) => l.category === 'skill').every((l) => l.source === 'fact-backfill'));
  assert.ok(t247.filter((l) => l.category === 'intention').every((l) => l.source === 'summary-backfill'));
  // 同名多人各自打标：389 只有旧事实的「招聘」技能，无意向
  assert.deepEqual(fake.linksFor(389), [{ name: '招聘', category: 'skill', source: 'fact-backfill' }]);
  assert.deepEqual(fake.linksFor(302), [], 'summary NULL 且无技能者零标签');
});

test('重跑幂等：第二次写入零新增', async () => {
  const fake = createFakeMysql();
  await runTalentTagBackfill({ mysql: fake.mysql, dryRun: false, now: T1 });
  const again = await runTalentTagBackfill({ mysql: fake.mysql, dryRun: false, now: T1 });
  assert.deepEqual(again.written, { tag_rows: 0, talent_tag_rows: 0 });
  assert.equal(fake.tag.size, 15);
  assert.equal(fake.talentTag.size, 16);
});

test('--talent 单人回填：只处理该 talent', async () => {
  const fake = createFakeMysql();
  const report = await runTalentTagBackfill({ mysql: fake.mysql, dryRun: false, talentId: 247, now: T1 });
  assert.equal(report.talents_scanned, 1);
  assert.deepEqual(report.written, { tag_rows: 5, talent_tag_rows: 5 });
  assert.equal(fake.talentTag.size, 5);
});

test('衔接：回填后 talent-match-run 读到标签，召回 0 → 1', async () => {
  const fake = createFakeMysql();
  const { db, jobId } = jobFixture();
  const before = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a', now: T1 });
  assert.equal(before.jobs[0].matched_count, 0, '零标签时文本维不足以召回任何人');

  await runTalentTagBackfill({ mysql: fake.mysql, dryRun: false, now: T1 });
  const after = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a', now: T1 });
  assert.equal(after.jobs[0].project_id, jobId);
  assert.equal(after.jobs[0].matched_count, 1);
  assert.equal(after.jobs[0].top[0].talent_id, 401, '意向标签命中职位后 401 被召回');
  db.close();
});
