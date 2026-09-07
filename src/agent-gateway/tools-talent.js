import { withMysql } from '../db.js';
import { candidateShortlist, maskCandidateName } from '../candidate-shortlist.js';
import { parseCandidateFact } from '../talent-contracts.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/** 空 shortlist 溯源（2026-09-04 wendy 案例）：模型把「内部短名单空」说成
 * 「找不到人/数据源挂了」——实际该岗位候选人由 OpenMai 找人异步产生，存于
 * openmai_results（RDS 短名单只覆盖部分合作岗位，不是全量候选人真值）。 */
function emptyShortlistGuidance(db, consultantId, jobId) {
  if (!db || !jobId) return null;
  try {
    const openmai = db.prepare('SELECT status FROM openmai_results WHERE project_id=? AND consultant_id=?')
      .get(jobId, consultantId);
    const engaged = db.prepare(`SELECT 1 FROM decision_events WHERE project_id=? AND actor=?
      AND event_type IN ('ACCEPTED','COMPLETED') LIMIT 1`).get(jobId, consultantId);
    if (openmai || engaged) {
      return openmai?.status === 'done'
        ? `该岗位的候选人结果已由 OpenMai 找人完成（openmai_results 有 done 记录），请调用 brainx_openmai_search(job_id) 获取完整候选人列表并呈现给顾问；本内部短名单（RDS）只覆盖部分合作岗位，为空不代表没有候选人，更不是数据源故障。`
        : `该岗位已进入 OpenMai 找人流程（状态：${openmai?.status || '进行中'}），请调用 brainx_openmai_search(job_id) 查询/刷新结果并呈现给顾问；本内部短名单（RDS）只覆盖部分合作岗位，为空不代表没有候选人。`;
    }
    return '当前岗位暂无授权的人才短名单数据（内部短名单仅覆盖部分合作岗位）。如需找候选人：先接单触发 OpenMai 找人，完成后用 brainx_openmai_search(job_id) 获取结果。';
  } catch { return null; }
}

async function loadAuthorizedCandidateFact(input, dependencies = {}) {
  const withConnection = dependencies.withConnection || withMysql;
  const sql = `SELECT cfv.facts_json
    FROM candidate_fact_versions cfv
    JOIN candidate_documents cd ON cd.document_id=cfv.document_id
    WHERE cfv.tenant_id=? AND cfv.candidate_ref=? AND cfv.quality_status='READY'
      AND cd.quality_status='READY'
      AND EXISTS (
        SELECT 1 FROM talent_access_grants tag
        WHERE tag.tenant_id=cfv.tenant_id AND tag.talent_id=cfv.talent_id
          AND tag.status='ACTIVE' AND tag.scope='resume_facts' AND tag.purpose=?
          AND tag.grantee_type='consultant' AND tag.grantee_ref=?
          AND tag.granted_at <= CURRENT_TIMESTAMP(3)
          AND (tag.expires_at IS NULL OR tag.expires_at > CURRENT_TIMESTAMP(3))
          AND (tag.revoked_at IS NULL OR tag.revoked_at > CURRENT_TIMESTAMP(3)))
    ORDER BY cfv.created_at DESC, cfv.fact_version_id DESC LIMIT 1`;
  let rows;
  try {
    rows = await withConnection(async (connection) => {
      const [result] = await connection.execute(sql, [
        input.tenantId, input.candidateRef, input.purpose, input.consultantId,
      ]);
      return result;
    });
  } catch {
    fail('SOURCE_UNAVAILABLE');
  }
  if (!rows[0]) fail('NOT_FOUND_OR_FORBIDDEN');
  try {
    const raw = typeof rows[0].facts_json === 'string' ? JSON.parse(rows[0].facts_json) : rows[0].facts_json;
    return parseCandidateFact(raw);
  } catch (error) {
    if (error?.code === 'NOT_FOUND_OR_FORBIDDEN') throw error;
    fail('QUALITY_INSUFFICIENT');
  }
}

async function loadAuthorizedCandidateContact(input, dependencies = {}) {
  const withConnection = dependencies.withConnection || withMysql;
  const sql = `SELECT t.phone, t.email
    FROM candidate_fact_versions cfv
    JOIN talent t ON t.id=cfv.talent_id
    WHERE cfv.tenant_id=? AND cfv.candidate_ref=?
      AND EXISTS (SELECT 1 FROM talent_access_grants tag
        WHERE tag.tenant_id=cfv.tenant_id AND tag.talent_id=cfv.talent_id
          AND tag.status='ACTIVE' AND tag.scope='contact' AND tag.purpose='candidate_contact'
          AND tag.grantee_type='consultant' AND tag.grantee_ref=?
          AND tag.granted_at <= CURRENT_TIMESTAMP(3)
          AND (tag.expires_at IS NULL OR tag.expires_at > CURRENT_TIMESTAMP(3))
          AND (tag.revoked_at IS NULL OR tag.revoked_at > CURRENT_TIMESTAMP(3)))
    ORDER BY cfv.created_at DESC LIMIT 1`;
  try {
    const rows = await withConnection(async (connection) => {
      const [result] = await connection.execute(sql, [input.tenantId, input.candidateRef, input.consultantId]);
      return result;
    });
    if (!rows[0]) fail('NOT_FOUND_OR_FORBIDDEN');
    return { phone: rows[0].phone || null, email: rows[0].email || null };
  } catch (error) {
    if (error?.code === 'NOT_FOUND_OR_FORBIDDEN') throw error;
    fail('SOURCE_UNAVAILABLE');
  }
}

function publicFact(fact) {
  const constraints = fact.constraints
    .filter((entry) => entry.name !== 'salary')
    .map((entry) => ({ name: entry.name, value: entry.value, state: entry.state, evidence_refs: entry.evidence_refs }));
  return {
    candidate_ref: fact.candidate_ref,
    display_name_masked: maskCandidateName(fact.identity.display_name),
    current_city: fact.identity.current_city || null,
    work_experiences: fact.work_experiences.map((entry) => ({
      company: entry.company, title: entry.title, start_date: entry.start_date || null,
      end_date: entry.end_date || null, is_current: entry.is_current === true,
      summary: entry.summary || null, achievements: entry.achievements,
      evidence_refs: entry.evidence_refs,
    })),
    education: fact.education.map((entry) => ({
      school: entry.school, degree: entry.degree || null, major: entry.major || null,
      start_date: entry.start_date || null, end_date: entry.end_date || null,
      evidence_refs: entry.evidence_refs,
    })),
    skills: fact.skills.map((entry) => ({
      name: entry.name, proficiency: entry.proficiency, evidence_refs: entry.evidence_refs,
    })),
    constraints,
    quality: fact.quality,
  };
}

function shortlistResult(bundle) {
  const items = bundle.items;
  return {
    data: bundle,
    facts: [
      ...(bundle.job_context ? [{ kind: 'job_context', ...bundle.job_context }] : []),
      ...items.map((entry) => ({
        kind: 'candidate', candidate_ref: entry.candidate_ref,
        display_name_masked: entry.display_name_masked, profile: entry.profile,
      })),
    ],
    inferences: items.map((entry) => ({
      candidate_ref: entry.candidate_ref, strength_score: entry.strength.score,
      strength_summary: entry.strength.summary, job_fit_score: entry.job_fit.score,
      job_fit_summary: entry.job_fit.summary, hard_conditions: entry.hard_conditions,
    })),
    recommendations: items.map((entry) => ({
      candidate_ref: entry.candidate_ref, rank: entry.rank,
      recommendation: entry.hard_conditions.some((condition) => condition.result === 'FAIL') ? '暂不推荐' : '建议优先核实',
      gaps: entry.gaps, risks: entry.risks,
    })),
    unknowns: unique([
      ...(bundle.job_context?.unknowns || []), ...items.flatMap((entry) => entry.unknowns),
    ]),
    evidence_refs: unique([
      ...(bundle.match_run ? [`match_run:${bundle.match_run.match_run_id}`] : []),
      ...items.flatMap((entry) => [...entry.strength.evidence_refs, ...entry.job_fit.evidence_refs,
        ...entry.hard_conditions.flatMap((condition) => condition.evidence_refs)]),
    ]),
    source_versions: bundle.match_run ? {
      match_run: bundle.match_run.match_run_id,
      algorithm: bundle.match_run.algorithm_version,
      features: bundle.match_run.feature_schema_version,
    } : {},
    next_allowed_actions: items.length ? ['brainx_candidate_fit', 'brainx_interview_prep'] : [],
  };
}

export function createTalentToolHandlers(options = {}) {
  const shortlistFn = options.candidateShortlistFn || candidateShortlist;
  const loadFact = options.loadCandidateFactFn || ((input) => loadAuthorizedCandidateFact(input, options));
  const loadContact = options.loadCandidateContactFn || ((input) => loadAuthorizedCandidateContact(input, options));
  const getShortlist = async (args, context, purpose = context.principal.purpose) => {
    const limit = Math.min(args.limit || 5, context.principal.chatType === 'group' ? 3 : 5);
    const bundle = await shortlistFn({
      tenantId: context.principal.tenantId, consultantId: context.principal.consultantId,
      jobId: args.job_id, pageToken: args.page_token, limit, purpose,
    });
    if (bundle.data_scope?.purpose !== purpose) fail('QUALITY_INSUFFICIENT');
    return bundle;
  };
  const getFact = (candidateRef, context, purpose = context.principal.purpose) => loadFact({
    tenantId: context.principal.tenantId, consultantId: context.principal.consultantId,
    candidateRef, purpose,
  });
  const findMatch = async (args, context, purpose) => {
    let pageToken;
    for (let page = 0; page < 4; page += 1) {
      const bundle = await getShortlist({ job_id: args.job_id, limit: 5, page_token: pageToken }, context, purpose);
      const match = bundle.items.find((entry) => entry.candidate_ref === args.candidate_ref);
      if (match) return { bundle, match };
      pageToken = bundle.page.next_page_token;
      if (!pageToken) break;
    }
    fail('NOT_FOUND_OR_FORBIDDEN');
  };

  return {
    brainx_candidate_contact: async (args, context) => {
      const contact = await loadContact({ tenantId: context.principal.tenantId,
        consultantId: context.principal.consultantId, candidateRef: args.candidate_ref });
      return { data: { candidate_ref: args.candidate_ref, contact },
        facts: [{ candidate_ref: args.candidate_ref, contact_available: Boolean(contact.phone || contact.email) }],
        inferences: [], recommendations: [], unknowns: contact.phone || contact.email ? [] : ['候选人联系方式为空'],
        evidence_refs: [`candidate_contact:${args.candidate_ref}`],
        next_allowed_actions: ['brainx_candidate_fit'] };
    },
    brainx_candidate_shortlist: async (args, context) => {
      const bundle = await getShortlist(args, context);
      const envelope = shortlistResult(bundle);
      if (!bundle.items?.length) {
        const guidance = emptyShortlistGuidance(options.db, context.principal.consultantId, args.job_id);
        if (guidance) envelope.unknowns.push(guidance);
      }
      return envelope;
    },
    brainx_candidate_facts: async (args, context) => {
      const fact = await getFact(args.candidate_ref, context, args.purpose);
      const projected = publicFact(fact);
      return {
        data: projected,
        facts: [{ candidate_ref: fact.candidate_ref, profile: projected }],
        inferences: [], recommendations: [],
        unknowns: unique([...fact.quality.unknown_fields, ...fact.quality.warnings, '候选人联系方式和薪资信息未向 Agent 开放']),
        evidence_refs: unique(fact.evidence.map((entry) => entry.evidence_ref)),
        source_versions: { candidate_fact: fact.fact_version_id, parser: fact.document.parser_version },
        next_allowed_actions: ['brainx_candidate_fit', 'brainx_gap_questions'],
      };
    },
    brainx_candidate_fit: async (args, context) => {
      const { bundle, match } = await findMatch(args, context, 'candidate_review');
      if (!bundle.match_run) fail('NOT_FOUND_OR_FORBIDDEN');
      return {
        data: { candidate_ref: match.candidate_ref, strength: match.strength, job_fit: match.job_fit,
          hard_conditions: match.hard_conditions, gaps: match.gaps, risks: match.risks,
          match_run: bundle.match_run, data_freshness: match.data_freshness },
        facts: match.hard_conditions.map((condition) => ({ criterion: condition.criterion,
          hard_filter_result: condition.result, evidence_refs: condition.evidence_refs })),
        inferences: [{ kind: 'candidate_strength', ...match.strength }, { kind: 'job_fit', ...match.job_fit }],
        recommendations: [{ candidate_ref: match.candidate_ref, rank: match.rank, risks: match.risks }],
        unknowns: match.unknowns, evidence_refs: unique([...match.strength.evidence_refs, ...match.job_fit.evidence_refs]),
        source_versions: { match_run: bundle.match_run.match_run_id, algorithm: bundle.match_run.algorithm_version },
        next_allowed_actions: ['brainx_interview_prep'],
      };
    },
    brainx_gap_questions: async (args, context) => {
      if (args.object_type === 'job') {
        if (!options.jobGapHandler) fail('TOOL_DISABLED');
        return options.jobGapHandler(args, context);
      }
      const fact = await getFact(args.object_ref, context, 'candidate_review');
      const questions = fact.quality.unknown_fields.slice(0, 3).map((field) => ({
        field, question: `请候选人补充确认：${field}。`, evidence_refs: [],
      }));
      return { data: { object_ref: args.object_ref, questions }, facts: [], inferences: [], recommendations: [],
        unknowns: fact.quality.unknown_fields, evidence_refs: unique(fact.evidence.map((entry) => entry.evidence_ref)).slice(0, 20) };
    },
    brainx_interview_prep: async (args, context) => {
      const { bundle, match } = await findMatch(args, context, 'interview_prep');
      if (!bundle.match_run) fail('NOT_FOUND_OR_FORBIDDEN');
      const prompts = unique([...match.gaps, ...match.risks, ...match.unknowns]).slice(0, 12);
      const questions = prompts.map((topic) => ({ topic, question: `请结合具体项目说明“${topic}”，并给出可核实的结果。` }));
      return {
        data: { candidate_ref: match.candidate_ref, job_ref: args.job_id, questions },
        facts: [{ strength: match.strength, job_fit: match.job_fit }], inferences: [],
        recommendations: questions.map((question) => ({ action: '面试核实', ...question })),
        unknowns: match.unknowns,
        evidence_refs: unique([`match_run:${bundle.match_run.match_run_id}`, ...match.strength.evidence_refs, ...match.job_fit.evidence_refs]),
        source_versions: { match_run: bundle.match_run.match_run_id, algorithm: bundle.match_run.algorithm_version },
      };
    },
  };
}
