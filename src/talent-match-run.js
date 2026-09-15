/** talent-match-run.js — 独立、可插拔的人才匹配跑批模块（预计算 candidate 短名单）。
 *
 * 目的：让 `brainx_candidate_shortlist` 工具（src/candidate-shortlist.js，只读预计算
 * 结果）对任意活跃职位有真实短名单返回。本模块是唯一写入方：把 SQLite 决策库的
 * 活跃职位 × RDS 人才库（talent + 标签）用既有 supply-match-v1 算法打分，把命中
 * 候选按 candidate_match_bundle_v1 契约落进 RDS 预计算链路（job_criteria_versions
 * → match_runs → candidate_documents/fact_versions → candidate_job_matches），
 * 并补齐两张授权账本（talent_access_grants 项目级 + job_access_grants 顾问级）。
 *
 * 纪律：
 *   1) 不改动任何现有主流程文件；SQLite 决策库只读，RDS 写入全部幂等（INSERT
 *      IGNORE + 内容寻址确定性 id），可任意重跑。
 *   2) dryRun=true（默认）零写入，只返回每职位报告。
 *   3) 授权最小化：人才侧按项目放行（grantee_type='project'，覆盖绑定群全部成员），
 *      职位侧按顾问放行（当前成员 ∪ 显式 granteeConsultants），purpose 固定
 *      'candidate_review'；重跑不产生重复授权（确定性 grant_id）。
 *
 * 调用方式（可插拔，模块自身不启动任何循环）：
 *   - CLI：node bin/brainx-talent-match-run.mjs [--write] [--job <project_id>]
 *   - worker/定时循环：拿到决策库句柄后
 *       await runTalentMatchRun({ db, dryRun: false });
 *     （建议低频调用，如每日一次；重复调用安全。）
 */
import { withMysql } from './db.js';
import { digest } from './reloop-shortlist-pipeline.js';
import {
  buildJobMatchContext,
  scoreTalentForJob,
  SUPPLY_MATCH_THRESHOLD,
} from './talent-supply.js';
import { parseCandidateFact, parseStoredCandidateMatchPayload } from './talent-contracts.js';

const ALGORITHM_VERSION = 'talent-match-run-v1+supply-match-v1';
const FEATURE_SCHEMA_VERSION = 'candidate_fact_v1';
const PARSER_VERSION = 'talent-db-structured-v1';
const SOURCE_SYSTEM = 'brainx_talent_db';
const GRANTOR = 'system:talent-match-run';
const PURPOSE = 'candidate_review';
// 现网唯一 tenant；优先从 SQLite feishu_identity_bindings 取 ACTIVE 绑定，取不到才用它。
const DEFAULT_TENANT = 'yorkteam';
const TALENT_POOL_LIMIT = 500; // 与 listTalentsWithTags 上限一致

const shortId = (prefix, value) => `${prefix}_${digest(value).slice(0, 48)}`;

// 事实/payload 会过 assertNoSensitiveText（手机号/邮箱 fail-closed），所有入库文本先脱敏。
const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const clean = (value, limit = 500) => String(value ?? '').trim()
  .replace(PHONE, '[已脱敏]').replace(EMAIL, '[已脱敏]').slice(0, limit);

const safeJson = (value) => {
  try { return typeof value === 'string' ? JSON.parse(value) : (value ?? {}); } catch { return {}; }
};

const score100 = (value) => Number((Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(2));

/** tenant 解析：显式参数 > feishu_identity_bindings ACTIVE 绑定 > 默认 'yorkteam'。 */
export function resolveTenantId(db, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  try {
    const row = db.prepare(`SELECT tenant_id FROM feishu_identity_bindings
      WHERE binding_status='ACTIVE' GROUP BY tenant_id
      ORDER BY COUNT(*) DESC, tenant_id ASC LIMIT 1`).get();
    if (row?.tenant_id) return row.tenant_id;
  } catch { /* 表不存在等场景落默认 */ }
  return DEFAULT_TENANT;
}

/**
 * 活跃职位选取（SQLite 只读）：job_facts.active_state='OPEN' 且 project_id 出现在
 * （bot_chat_intake BOUND ∪ project_launches READY ∪ job_memberships 当前 MY_JOB/TEAM_SHARED）。
 * 传了 jobId 就只跑该职位（仍需满足上述活跃+可见条件）。
 */
export function listActiveJobs(db, jobId) {
  const sql = `SELECT jf.project_id, jf.company, jf.role, jf.city, jf.pipeline, jf.raw_json
    FROM job_facts jf
    WHERE jf.active_state = 'OPEN'
      AND (EXISTS (SELECT 1 FROM bot_chat_intake bci
             WHERE bci.project_id = jf.project_id AND bci.status = 'BOUND')
        OR EXISTS (SELECT 1 FROM project_launches pl
             WHERE pl.project_id = jf.project_id AND pl.status = 'READY')
        OR EXISTS (SELECT 1 FROM job_memberships jm
             WHERE jm.project_id = jf.project_id AND jm.valid_to IS NULL
               AND jm.relation IN ('MY_JOB','TEAM_SHARED')))
      ${jobId ? 'AND jf.project_id = ?' : ''}
    ORDER BY jf.project_id ASC`;
  const rows = jobId ? db.prepare(sql).all(jobId) : db.prepare(sql).all();
  return rows.map((row) => {
    const raw = safeJson(row.raw_json);
    return {
      project_id: row.project_id,
      company: row.company,
      role: row.role,
      city: row.city,
      pipeline: row.pipeline,
      notes: clean(raw.notes || raw.requirements || '', 1_000),
    };
  });
}

/** 职位当前顾问集合（job_access_grants 放行对象）：当前成员 ∪ 显式参数。 */
export function jobConsultants(db, projectId, extra = []) {
  const members = db.prepare(`SELECT DISTINCT consultant_id FROM job_memberships
    WHERE project_id = ? AND valid_to IS NULL`).all(projectId)
    .map((row) => row.consultant_id);
  return [...new Set([...members, ...extra].map((v) => String(v || '').trim()).filter(Boolean))].sort();
}

/** 职位条件版本内容（candidate-shortlist 的 jobContextFromRow 读取口径）。 */
function criteriaFor(job) {
  return {
    title: clean(job.role, 200) || '当前职位',
    summary: clean(`${job.company || ''} ${job.notes || ''}`.trim(), 1_000) || null,
    experience: null, education: null,
    location: clean(job.city, 200) || null,
    required_skills: [], preferred_skills: [], responsibilities: [],
  };
}

/** 人才库（talent + 标签）经同一连接读取，供打分与写同事务使用。 */
async function loadTalentsWithTags(conn, limit = TALENT_POOL_LIMIT) {
  const lim = Math.max(1, Math.min(500, Number(limit) || TALENT_POOL_LIMIT));
  const [rows] = await conn.query(`SELECT * FROM talent ORDER BY id DESC LIMIT ${lim}`);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [tagRows] = await conn.query(
    `SELECT tt.talent_id, g.name, g.category FROM talent_tag tt
     JOIN tag g ON g.id = tt.tag_id WHERE tt.talent_id IN (?)`, [ids]);
  const byTalent = new Map();
  for (const tr of tagRows) {
    if (!byTalent.has(tr.talent_id)) byTalent.set(tr.talent_id, []);
    byTalent.get(tr.talent_id).push({ name: tr.name, category: tr.category });
  }
  return rows.map((row) => ({ ...row, tags: byTalent.get(row.id) || [] }));
}

/**
 * 由 talent 行构造 candidate_fact_v1（严格 schema，过 parseCandidateFact）。
 * candidate_ref 生成规则：`talent-db:<talent.id>` —— 以 RDS 人才主键为受控稳定引用，
 * 重跑同人同 ref；不写联系方式（phone/email 留在权威源，与 reloop 管道同一纪律）。
 * talent 表无结构化经历，work_experiences/education 置空并在 unknown_fields 声明。
 */
export function buildTalentFact(talent, { processedAt }) {
  const candidateRef = `talent-db:${talent.id}`;
  const name = clean(talent.name, 100) || '候选人';
  const skillNames = [...new Set((talent.tags || [])
    .filter((tag) => tag.category === 'skill')
    .map((tag) => clean(tag.name, 120)).filter(Boolean))].slice(0, 30);

  const evidence = [];
  const addEvidence = (fieldPath, sourcePath, value) => {
    const evidenceRef = shortId('mev', { candidateRef, fieldPath, value });
    evidence.push({ evidence_ref: evidenceRef, field_path: fieldPath,
      source_ref: candidateRef, section: sourcePath, excerpt_hash: digest(String(value)) });
    return evidenceRef;
  };
  const nameEvidence = addEvidence('identity.display_name', 'talent.name', name);
  const skills = skillNames.map((skill, index) => ({
    name: skill, normalized_name: skill.toLowerCase(), proficiency: 'EXPLICIT',
    evidence_refs: [addEvidence(`skills.${index}`, 'talent_tag.skill', skill)],
  }));

  const contentHash = digest({ candidateRef, name, skills: skillNames,
    summary: clean(talent.summary, 1_000) });
  return parseCandidateFact({
    schema_version: 'candidate_fact_v1',
    fact_version_id: shortId('mfact', { candidateRef, contentHash }),
    candidate_ref: candidateRef,
    document: { document_ref: candidateRef, source_format: 'legacy_text',
      content_hash: contentHash, parser_version: PARSER_VERSION,
      processed_at: new Date(processedAt).toISOString() },
    identity: { display_name: name, evidence_refs: [nameEvidence] },
    work_experiences: [], education: [], skills, constraints: [], evidence,
    quality: { status: 'READY', evidence_coverage: 1,
      unknown_fields: ['work_experiences', 'education', 'constraints.location',
        'constraints.salary', 'constraints.availability'],
      warnings: ['联系方式仅保留在权威源，未进入 Agent 事实契约'] },
  });
}

/** 命中候选的 stored payload（过 parseStoredCandidateMatchPayload；得分可解释）。 */
export function buildTalentMatchPayload(detail, fact) {
  const skillRefs = fact.evidence.filter((e) => e.field_path.startsWith('skills.'))
    .map((e) => e.evidence_ref).slice(0, 50);
  const dims = detail.dimensions;
  const hits = [...dims.skill.matched, ...dims.intent.matched].slice(0, 8);
  const pct = (rate) => Math.round((Number(rate) || 0) * 100);
  return parseStoredCandidateMatchPayload({
    strength_summary: hits.length
      ? `技能/意向标签命中：${hits.join('、')}`
      : '文本摘要与职位相关，标签维度命中有限，需顾问复核',
    strength_evidence_refs: skillRefs,
    job_fit_summary: `supply-match-v1 三维加权：技能命中率 ${pct(dims.skill.rate)}%、`
      + `意向命中率 ${pct(dims.intent.rate)}%、文本命中率 ${pct(dims.text.rate)}%`,
    job_fit_evidence_refs: skillRefs,
    hard_conditions: [], gaps: [], risks: [],
    unknowns: ['工作经历未结构化', '期望薪资未确认', '到岗时间未确认'],
    freshness_status: 'FRESH',
  });
}

/** 单职位打分：score >= SUPPLY_MATCH_THRESHOLD 的前 limit 名（分数降序、id 升序定序）。 */
function rankCandidates(talents, job, limit) {
  const ctx = buildJobMatchContext(job);
  return talents
    .map((talent) => ({ talent, ...scoreTalentForJob(talent, ctx) }))
    .filter((entry) => entry.score >= SUPPLY_MATCH_THRESHOLD)
    .sort((a, b) => (b.score - a.score) || (a.talent.id - b.talent.id))
    .slice(0, limit);
}

/** 单事务写入一个职位的完整预计算链路（全部 INSERT IGNORE / 确定性 id）。 */
async function writeJobRun(conn, tenantId, job, entries, ids, consultants, at) {
  await conn.execute(
    `INSERT IGNORE INTO job_criteria_versions
       (job_version_id, tenant_id, external_job_ref, position_id, schema_version,
        criteria_json, source_hash, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    [ids.jobVersionId, tenantId, job.project_id, 'job-facts-v1',
      JSON.stringify(criteriaFor(job)), ids.sourceHash, at],
  );
  await conn.execute(
    `INSERT IGNORE INTO match_runs
       (match_run_id, tenant_id, job_version_id, algorithm_version, feature_schema_version,
        status, candidate_count, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, 'SUCCEEDED', ?, ?, ?)`,
    [ids.matchRunId, tenantId, ids.jobVersionId, ALGORITHM_VERSION,
      FEATURE_SCHEMA_VERSION, entries.length, at, at],
  );
  let rank = 0;
  for (const { talent, fact, payload, strengthScore, fitScore } of entries) {
    rank += 1;
    const documentId = shortId('mdoc', { talentId: talent.id, hash: fact.document.content_hash });
    await conn.execute(
      `INSERT IGNORE INTO candidate_documents
         (document_id, talent_id, source_system, source_document_ref, source_format,
          content_hash, parser_version, quality_status, ingested_at, processed_at)
       VALUES (?, ?, ?, ?, 'legacy_text', ?, ?, 'READY', ?, ?)`,
      [documentId, talent.id, SOURCE_SYSTEM, fact.candidate_ref,
        fact.document.content_hash, PARSER_VERSION, at, at],
    );
    await conn.execute(
      `INSERT IGNORE INTO candidate_fact_versions
         (fact_version_id, tenant_id, talent_id, candidate_ref, document_id, schema_version,
          facts_json, evidence_coverage, quality_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?)`,
      [fact.fact_version_id, tenantId, talent.id, fact.candidate_ref, documentId,
        fact.schema_version, JSON.stringify(fact), fact.quality.evidence_coverage, at],
    );
    await conn.execute(
      `INSERT IGNORE INTO candidate_job_matches
         (match_run_id, talent_id, fact_version_id, \`rank\`, strength_score,
          job_fit_score, hard_filter_result, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'UNKNOWN', ?, ?)`,
      [ids.matchRunId, talent.id, fact.fact_version_id, rank,
        strengthScore, fitScore, JSON.stringify(payload), at],
    );
    await conn.execute(
      `INSERT IGNORE INTO talent_access_grants
         (grant_id, tenant_id, talent_id, source_system, source_account_ref,
          grantor_consultant_id, grantee_type, grantee_ref, scope, purpose, status,
          granted_at, source_proof_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'project', ?, 'resume_facts', ?, 'ACTIVE', ?, ?)`,
      [shortId('mtgrant', { tenantId, talentId: talent.id, project: job.project_id, PURPOSE }),
        tenantId, talent.id, SOURCE_SYSTEM, 'talent-db', GRANTOR, job.project_id,
        PURPOSE, at, 'talent-match-run:project-scope'],
    );
  }
  for (const consultantId of consultants) {
    await conn.execute(
      `INSERT IGNORE INTO job_access_grants
         (grant_id, tenant_id, external_job_ref, source_system, source_account_ref,
          grantor_consultant_id, grantee_type, grantee_ref, purpose, status,
          granted_at, source_proof_ref)
       VALUES (?, ?, ?, ?, ?, ?, 'consultant', ?, ?, 'ACTIVE', ?, ?)`,
      [shortId('mjgrant', { tenantId, job: job.project_id, consultantId, PURPOSE }),
        tenantId, job.project_id, SOURCE_SYSTEM, 'job_memberships', GRANTOR,
        consultantId, PURPOSE, at, 'talent-match-run:job-membership'],
    );
  }
  return rank;
}

/**
 * 跑批入口。
 * @param {object} input
 * @param {object} input.db   SQLite 决策库句柄（只读使用）。
 * @param {Function} [input.mysql]  withConnection 风格 (fn)=>fn(conn)，默认 withMysql。
 * @param {string} [input.jobId]    只跑该 project_id。
 * @param {boolean} [input.dryRun]  默认 true：零写入，只返回报告。
 * @param {number} [input.limit]    每职位短名单上限（默认 20，最大 20）。
 * @param {string[]} [input.granteeConsultants] 额外放行的顾问。
 * @param {string} [input.tenantId] 显式 tenant（默认从绑定表/缺省值解析）。
 * @param {Date|string} [input.now] 注入时钟（测试确定性用）。
 */
export async function runTalentMatchRun(input = {}) {
  const { db } = input;
  if (!db) throw new Error('db required');
  const dryRun = input.dryRun !== false;
  const limit = Math.max(1, Math.min(20, Number(input.limit) || 20));
  const tenantId = resolveTenantId(db, input.tenantId);
  const at = input.now ? new Date(input.now) : new Date();
  const jobs = listActiveJobs(db, input.jobId);
  const connect = input.mysql || withMysql;

  return connect(async (conn) => {
    const talents = jobs.length ? await loadTalentsWithTags(conn) : [];
    const plans = jobs.map((job) => {
      const ranked = rankCandidates(talents, job, limit);
      const entries = ranked.map(({ talent, score, detail }) => {
        const fact = buildTalentFact(talent, { processedAt: at });
        return { talent, fact, payload: buildTalentMatchPayload(detail, fact),
          score, strengthScore: score100(detail.dimensions.skill.rate * 0.7
            + detail.dimensions.intent.rate * 0.3),
          fitScore: score100(score) };
      });
      const sourceHash = digest({ tenantId, job: job.project_id, criteria: criteriaFor(job) });
      const jobVersionId = shortId('mjob', { tenantId, job: job.project_id, sourceHash });
      const matchRunId = shortId('mrun', { tenantId, jobVersionId, startedAt: at.toISOString(),
        algorithm: ALGORITHM_VERSION, facts: entries.map((e) => e.fact.fact_version_id) });
      const consultants = jobConsultants(db, job.project_id, input.granteeConsultants || []);
      return { job, entries, consultants, ids: { jobVersionId, matchRunId, sourceHash } };
    });

    const report = {
      dry_run: dryRun, tenant_id: tenantId, ran_at: at.toISOString(),
      algorithm_version: ALGORITHM_VERSION, threshold: SUPPLY_MATCH_THRESHOLD,
      talent_pool_size: talents.length, jobs: plans.map(({ job, entries, consultants, ids }) => ({
        project_id: job.project_id, company: job.company, role: job.role,
        matched_count: entries.length, grantee_consultants: consultants,
        job_version_id: ids.jobVersionId, match_run_id: ids.matchRunId,
        top: entries.map((e, i) => ({ rank: i + 1, talent_id: e.talent.id,
          candidate_ref: e.fact.candidate_ref, name: e.talent.name, score: e.score })),
        written: dryRun ? null : { candidates: entries.length, grants: entries.length + consultants.length },
      })),
    };
    if (dryRun || !plans.length) return report;

    await conn.beginTransaction();
    try {
      for (const plan of plans) {
        await writeJobRun(conn, tenantId, plan.job, plan.entries, plan.ids, plan.consultants, at);
      }
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    }
    return report;
  });
}
