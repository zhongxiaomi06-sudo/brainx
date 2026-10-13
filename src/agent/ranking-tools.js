/** Algorithm A 专用的五个只读窄工具。身份和租户只从服务端 principal 注入。 */
import { effectiveJob, effectiveJobs } from '../facts.js';
import { ignoredProjectIds } from '../opportunity-ignore.js';
import { currentConsultantContext } from '../profile-outcome-ledger.js';
import { jobVisibleTo } from '../visibility.js';

const DEFINITIONS = [
  ['get_profile_context', '读取本人主动画像、短期信号和当前负载', {}],
  ['search_eligible_jobs', '搜索当前仍合格且可见的职位摘要', {
    limit: { type: 'integer', minimum: 1, maximum: 50 },
    cursor: { type: 'integer', minimum: 0 },
  }],
  ['get_job_evidence', '读取一个可见职位的版本化事实与字段证据', {
    job_id: { type: 'string' }, fact_version: { type: 'string' },
  }, ['job_id']],
  ['get_delivery_history', '读取本人可追溯的聚合交付结果', {
    job_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  }],
  ['get_supply_summary', '读取一个可见职位的脱敏人才供给摘要', {
    job_id: { type: 'string' },
  }, ['job_id']],
];

function toolError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function assertActive(signal) {
  if (signal?.aborted) throw toolError('RANKING_TOOL_CANCELLED');
}

function requireVisible(db, principal, jobId) {
  const job = effectiveJob(db, principal.consultantId, String(jobId || ''));
  if (!job || !jobVisibleTo(db, principal.consultantId, job.project_id)) {
    throw toolError('RANKING_JOB_NOT_FOUND');
  }
  return job;
}

function safeSupply(result = {}) {
  return {
    available: result.available === true,
    status: String(result.status || (result.available ? 'available' : 'missing')).slice(0, 40),
    matchable_count: Number.isInteger(result.matchable_count) ? result.matchable_count : null,
    reliability: result.reliability == null ? null : String(result.reliability).slice(0, 40),
    version: result.version == null ? null : String(result.version).slice(0, 120),
    calculated_at: result.calculated_at == null ? null : String(result.calculated_at).slice(0, 40),
    unknowns: Array.isArray(result.unknowns) ? result.unknowns.map(String).slice(0, 20) : [],
  };
}

function toolSchema([name, description, properties, required = []]) {
  return {
    type: 'function',
    function: { name, description, parameters: {
      type: 'object', additionalProperties: false, properties, required,
    } },
  };
}

export function createRankingToolRegistry({ db, principal, supplySummaryFn = null }) {
  if (!principal?.tenantId || !principal?.consultantId || !principal?.authorizationVersion) {
    throw new TypeError('排名工具 principal 不完整');
  }
  const handlers = {
    get_profile_context: async (_args, options) => {
      assertActive(options.signal);
      const context = currentConsultantContext(db, {
        tenantId: principal.tenantId, consultantId: principal.consultantId,
      });
      return { ...context, signals: context.signals.slice(0, 100),
        signals_truncated: context.signals.length > 100 };
    },
    search_eligible_jobs: async (args, options) => {
      assertActive(options.signal);
      const ignored = ignoredProjectIds(db, principal.consultantId);
      const accepted = new Set(db.prepare(`SELECT project_id FROM current_engagement
        WHERE consultant_id=? AND state='ACCEPTED'`).all(principal.consultantId)
        .map((row) => row.project_id));
      const jobs = effectiveJobs(db, principal.consultantId)
        .filter((job) => job.active_state === 'OPEN' && job.hc !== 0)
        .filter((job) => jobVisibleTo(db, principal.consultantId, job.project_id))
        .filter((job) => !ignored.has(job.project_id) && !accepted.has(job.project_id))
        .sort((a, b) => a.project_id.localeCompare(b.project_id));
      const cursor = Number.isInteger(args.cursor) && args.cursor > 0 ? args.cursor : 0;
      const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, args.limit)) : 20;
      return {
        tenant_id: principal.tenantId, consultant_id: principal.consultantId,
        authorization_version: principal.authorizationVersion,
        total: jobs.length, cursor, next_cursor: cursor + limit < jobs.length ? cursor + limit : null,
        items: jobs.slice(cursor, cursor + limit).map((job) => ({
          job_id: job.project_id, company: job.company, role: job.role,
          active_state: job.active_state, remaining_hc: job.hc,
          captured_at: job.captured_at,
        })),
      };
    },
    get_job_evidence: async (args, options) => {
      assertActive(options.signal);
      const job = requireVisible(db, principal, args.job_id);
      const version = args.fact_version
        ? db.prepare(`SELECT * FROM job_fact_versions
          WHERE tenant_id=? AND job_id=? AND fact_version=?`).get(
          principal.tenantId, job.project_id, args.fact_version)
        : db.prepare(`SELECT * FROM job_fact_versions
          WHERE tenant_id=? AND job_id=? ORDER BY version DESC LIMIT 1`).get(
          principal.tenantId, job.project_id);
      if (!version) throw toolError('RANKING_JOB_VERSION_NOT_FOUND');
      const evidence = db.prepare(`SELECT evidence_id, field_path, value_json, origin_kind,
        evidence_ref, source_span, source_time, confidence, review_status
        FROM job_field_evidence WHERE fact_version=? ORDER BY field_path, evidence_id LIMIT 200`)
        .all(version.fact_version).map((row) => ({
          ...row, source_span: row.source_span == null ? null : String(row.source_span).slice(0, 500),
        }));
      return {
        job_id: job.project_id, fact_version: version.fact_version,
        source_snapshot_id: version.source_snapshot_id, facts: JSON.parse(version.facts_json),
        evidence, authorization_version: principal.authorizationVersion,
      };
    },
    get_delivery_history: async (args, options) => {
      assertActive(options.signal);
      if (args.job_id) requireVisible(db, principal, args.job_id);
      const limit = Number.isInteger(args.limit) ? Math.min(100, Math.max(1, args.limit)) : 50;
      const rows = args.job_id
        ? db.prepare(`SELECT stage, event_kind, attributed, occurred_at, project_id
          FROM business_outcome_events WHERE tenant_id=? AND consultant_id=? AND project_id=?
          ORDER BY occurred_at DESC LIMIT ?`).all(
          principal.tenantId, principal.consultantId, args.job_id, limit)
        : db.prepare(`SELECT stage, event_kind, attributed, occurred_at, project_id
          FROM business_outcome_events WHERE tenant_id=? AND consultant_id=?
          ORDER BY occurred_at DESC LIMIT ?`).all(principal.tenantId, principal.consultantId, limit);
      const counts = {};
      for (const row of rows) counts[row.stage] = (counts[row.stage] || 0) + 1;
      return { consultant_id: principal.consultantId, sample_count: rows.length, counts, items: rows };
    },
    get_supply_summary: async (args, options) => {
      assertActive(options.signal);
      const job = requireVisible(db, principal, args.job_id);
      if (!supplySummaryFn) return { job_id: job.project_id, available: false, status: 'missing' };
      const result = await supplySummaryFn({
        tenantId: principal.tenantId, consultantId: principal.consultantId,
        jobId: job.project_id, authorizationVersion: principal.authorizationVersion,
        signal: options.signal,
      });
      assertActive(options.signal);
      return { job_id: job.project_id, ...safeSupply(result) };
    },
  };

  return {
    names: () => DEFINITIONS.map(([name]) => name),
    tools: () => DEFINITIONS.map(toolSchema),
    async call(name, args = {}, options = {}) {
      const handler = handlers[name];
      if (!handler) throw toolError('RANKING_TOOL_NOT_ALLOWED');
      const controller = new AbortController();
      const timeoutMs = Number.isInteger(options.timeoutMs)
        ? Math.min(30_000, Math.max(1, options.timeoutMs)) : 5_000;
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const timeout = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(toolError(options.signal?.aborted
            ? 'RANKING_TOOL_CANCELLED' : 'RANKING_TOOL_TIMEOUT'));
        }, { once: true });
      });
      try {
        return await Promise.race([
          handler(args && typeof args === 'object' ? args : {}, { signal: controller.signal }),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}
