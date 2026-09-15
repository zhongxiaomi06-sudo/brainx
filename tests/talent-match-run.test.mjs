/** talent-match-run.test.mjs — 人才匹配跑批模块（不触网、不触真 RDS）。
 * SQLite :memory:（openDb + runSync fixture）+ 有状态 fake mysql conn：
 * 按 INSERT 列名/VALUES 位置解析入库，按 candidate-shortlist.js 文档化语义
 * （LATEST_RUN / AUTHORIZED / AUTHORIZED_JOB / READY）回放短名单读取。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, now } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { runTalentMatchRun } from '../src/talent-match-run.js';
import { candidateShortlist } from '../src/candidate-shortlist.js';

const T1 = '2026-09-15T01:00:00.000Z';
const T2 = '2026-09-15T02:00:00.000Z';

// 打分确定性：role 'Java 开发工程师' → reqTerms 含 java/开发/工程…；
// t1(0.317)/t2(0.58) 过 0.15 阈值，t3 无任何命中得分 0 被剔除。
const TALENTS = [
  { id: 1, name: '王强', status: 'active', summary: '5 年 Java 后端开发经验', phone: null, email: null },
  { id: 2, name: '李梅', status: 'active', summary: 'Java 微服务开发', phone: null, email: null },
  { id: 3, name: '赵影', status: 'active', summary: '', phone: null, email: null },
];
const TALENT_TAGS = [
  { talent_id: 1, name: 'java', category: 'skill' },
  { talent_id: 1, name: 'spring', category: 'skill' },
  { talent_id: 2, name: 'java', category: 'skill' },
  { talent_id: 3, name: '摄影', category: 'skill' },
];

function fixture() {
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

const PK = {
  job_criteria_versions: (r) => r.job_version_id,
  match_runs: (r) => r.match_run_id,
  candidate_documents: (r) => r.document_id,
  candidate_fact_versions: (r) => r.fact_version_id,
  candidate_job_matches: (r) => `${r.match_run_id}|${r.talent_id}`,
  talent_access_grants: (r) => r.grant_id,
  job_access_grants: (r) => r.grant_id,
};

function createFakeMysql() {
  const tables = Object.fromEntries(Object.keys(PK).map((k) => [k, new Map()]));
  const attempted = []; // 全部 INSERT 尝试（dry-run 零写入断言用）
  const tx = { begin: 0, commit: 0, rollback: 0 };

  const literal = (token, params) => {
    const t = token.trim();
    if (t === '?') return params.shift();
    if (/^null$/i.test(t)) return null;
    return t.replace(/^'|'$/g, '');
  };

  function shortlistRows(params) {
    const [tenantId, jobId, , purpose, consultantId] = params;
    const runs = [...tables.match_runs.values()]
      .filter((r) => r.tenant_id === tenantId && r.status === 'SUCCEEDED' && r.completed_at)
      .filter((r) => tables.job_criteria_versions.get(r.job_version_id)?.external_job_ref === jobId)
      .sort((a, b) => (new Date(b.completed_at) - new Date(a.completed_at))
        || String(b.match_run_id).localeCompare(String(a.match_run_id)));
    const latest = runs[0];
    if (!latest) return [];
    const jcv = tables.job_criteria_versions.get(latest.job_version_id);
    const jobGranted = [...tables.job_access_grants.values()].some((g) =>
      g.tenant_id === tenantId && g.external_job_ref === jobId && g.status === 'ACTIVE'
      && g.purpose === purpose && g.grantee_type === 'consultant' && g.grantee_ref === consultantId);
    if (!jobGranted) return [];
    const rows = [];
    for (const m of [...tables.candidate_job_matches.values()]
      .filter((m) => m.match_run_id === latest.match_run_id)
      .sort((a, b) => a.rank - b.rank)) {
      const cfv = tables.candidate_fact_versions.get(m.fact_version_id);
      const cd = tables.candidate_documents.get(cfv?.document_id);
      const talent = TALENTS.find((t) => t.id === m.talent_id);
      if (!cfv || !cd || !talent || cfv.quality_status !== 'READY') continue;
      const granted = [...tables.talent_access_grants.values()].some((g) =>
        g.tenant_id === tenantId && g.talent_id === m.talent_id && g.status === 'ACTIVE'
        && g.scope === 'resume_facts' && g.purpose === purpose
        && ((g.grantee_type === 'consultant' && g.grantee_ref === consultantId)
          || (g.grantee_type === 'project' && g.grantee_ref === jobId)));
      if (!granted) continue;
      rows.push({
        match_run_id: latest.match_run_id, algorithm_version: latest.algorithm_version,
        feature_schema_version: latest.feature_schema_version, completed_at: latest.completed_at,
        candidate_ref: cfv.candidate_ref, candidate_name: talent.name, match_rank: m.rank,
        strength_score: m.strength_score, job_fit_score: m.job_fit_score,
        hard_filter_result: m.hard_filter_result, payload_json: m.payload_json,
        facts_json: cfv.facts_json, criteria_json: jcv.criteria_json,
        fact_processed_at: cd.processed_at,
      });
    }
    return rows;
  }

  const conn = {
    tables, attempted, tx,
    async query(sql, params = []) {
      if (/FROM talent ORDER BY id DESC/.test(sql)) {
        return [TALENTS.slice().sort((a, b) => b.id - a.id)];
      }
      if (/FROM talent_tag/.test(sql)) {
        const ids = new Set(params[0]);
        return [TALENT_TAGS.filter((t) => ids.has(t.talent_id))];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    async execute(sql, params = []) {
      const im = sql.match(/INSERT IGNORE INTO (\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i);
      if (im) {
        attempted.push(im[1]);
        const cols = im[2].split(',').map((c) => c.trim().replace(/`/g, ''));
        const tokens = im[3].split(',');
        const rest = [...params];
        const row = Object.fromEntries(cols.map((c, i) => [c, literal(tokens[i], rest)]));
        const store = tables[im[1]];
        const key = PK[im[1]](row);
        if (store.has(key)) return [{ affectedRows: 0 }];
        store.set(key, row);
        return [{ affectedRows: 1 }];
      }
      if (/FROM match_runs mr/.test(sql)) return [shortlistRows(params)];
      throw new Error(`unexpected execute: ${sql}`);
    },
    async beginTransaction() { tx.begin += 1; },
    async commit() { tx.commit += 1; },
    async rollback() { tx.rollback += 1; },
  };
  return { conn, mysql: (fn) => fn(conn), tables, attempted, tx };
}

test('dry-run（默认）：零写入，报告候选数与 top 名单正确', async () => {
  const { db, jobId } = fixture();
  const fake = createFakeMysql();
  const report = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a', now: T1 });
  assert.equal(report.dry_run, true);
  assert.equal(report.talent_pool_size, 3);
  assert.equal(report.jobs.length, 1);
  const job = report.jobs[0];
  assert.equal(job.project_id, jobId);
  assert.equal(job.matched_count, 2, '低于阈值的赵影不入选');
  assert.deepEqual(job.top.map((t) => t.name), ['李梅', '王强']);
  assert.equal(job.written, null);
  assert.deepEqual(fake.attempted, [], 'dry-run 不得有任何 INSERT');
  assert.equal(fake.tx.begin, 0, 'dry-run 不开事务');
  db.close();
});

test('write 模式：candidateShortlist 全链（LATEST_RUN/授权/bundle schema）返回候选', async () => {
  const { db, jobId } = fixture();
  const fake = createFakeMysql();
  const report = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a',
    dryRun: false, now: T1 });
  assert.equal(fake.tx.begin, 1);
  assert.equal(fake.tx.commit, 1);
  assert.equal(report.jobs[0].written.candidates, 2);

  const out = await candidateShortlist({ tenantId: 'tenant_a', consultantId: 'felix',
    jobId, purpose: 'candidate_review' }, { withConnection: fake.mysql });
  assert.equal(out.schema_version, 'candidate_match_bundle_v1');
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].display_name_masked, '李*');
  assert.equal(out.items[0].rank, 1);
  assert.equal(out.items[0].candidate_ref, 'talent-db:2');
  assert.equal(out.job_context.title, 'Java 开发工程师');
  assert.equal(out.match_run.match_run_id, report.jobs[0].match_run_id);
  assert.equal(JSON.stringify(out).includes('李梅'), false, '响应只出脱敏名');

  const stranger = await candidateShortlist({ tenantId: 'tenant_a', consultantId: 'mia',
    jobId, purpose: 'candidate_review' }, { withConnection: fake.mysql });
  assert.deepEqual(stranger.items, [], '无 job_access_grants 的顾问 fail-closed');
  db.close();
});

test('重复运行幂等：授权不重复、新 match_run 版本、短名单取最新', async () => {
  const { db, jobId } = fixture();
  const fake = createFakeMysql();
  const first = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a',
    dryRun: false, now: T1 });
  const second = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a',
    dryRun: false, now: T2 });
  assert.notEqual(first.jobs[0].match_run_id, second.jobs[0].match_run_id, '每次跑出新版本');
  assert.equal(fake.tables.talent_access_grants.size, 2, '项目级人才授权不重复');
  assert.equal(fake.tables.job_access_grants.size, 1, '顾问级职位授权不重复');
  assert.equal(fake.tables.match_runs.size, 2);
  assert.equal(fake.tables.candidate_documents.size, 2, '文档按内容寻址去重');
  assert.equal(fake.tables.candidate_fact_versions.size, 2, '事实版本按内容寻址去重');
  assert.equal(fake.tables.candidate_job_matches.size, 4, '每轮 run 各自落排名明细');

  const out = await candidateShortlist({ tenantId: 'tenant_a', consultantId: 'felix',
    jobId, purpose: 'candidate_review' }, { withConnection: fake.mysql });
  assert.equal(out.match_run.match_run_id, second.jobs[0].match_run_id, '短名单取最新 run');
  assert.equal(out.items.length, 2);
  db.close();
});

test('低于阈值候选不写入任何预计算表', async () => {
  const { db } = fixture();
  const fake = createFakeMysql();
  await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a', dryRun: false, now: T1 });
  for (const doc of fake.tables.candidate_documents.values()) {
    assert.notEqual(doc.talent_id, 3);
  }
  for (const grant of fake.tables.talent_access_grants.values()) {
    assert.notEqual(grant.talent_id, 3, '未入选者不得放行简历事实');
    assert.equal(grant.grantee_type, 'project');
    assert.equal(grant.scope, 'resume_facts');
    assert.equal(grant.purpose, 'candidate_review');
  }
  db.close();
});

test('jobId 参数只跑指定职位；granteeConsultants 并入职位授权', async () => {
  const { db, jobId } = fixture();
  const fake = createFakeMysql();
  const report = await runTalentMatchRun({ db, mysql: fake.mysql, tenantId: 'tenant_a',
    jobId, granteeConsultants: ['york'], dryRun: false, now: T1 });
  assert.equal(report.jobs.length, 1);
  assert.deepEqual(report.jobs[0].grantee_consultants, ['felix', 'york']);
  assert.equal(fake.tables.job_access_grants.size, 2);
  db.close();
});
