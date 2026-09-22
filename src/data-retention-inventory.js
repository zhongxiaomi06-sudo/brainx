/** 只读数据生命周期盘点；只输出聚合元数据，不返回任何业务内容或标识。 */

const BLOCKERS = Object.freeze([
  'OWNER_UNASSIGNED', 'TTL_UNAPPROVED', 'RECOVERY_POINT_UNVERIFIED',
]);

const RAW_CONTEXT_TABLES = Object.freeze([
  { table: 'job_facts', payload: ['raw_json'], time: 'updated_at' },
  { table: 'lark_messages', payload: ['text', 'mentions_json'], time: 'received_at' },
  { table: 'job_facts_drafts',
    payload: ['raw_json', 'company_evidence', 'role_evidence'], time: 'extracted_at' },
]);

const CATEGORY_POLICY = Object.freeze({
  ttc_field_reports: {
    authority: 'DERIVED_AUDIT_EVIDENCE', purpose: '同步字段覆盖率与差异审计',
    owner_roles: ['DATA_OWNER', 'ENGINEERING_OWNER'],
  },
  sync_runs: {
    authority: 'AUTHORITATIVE_LINEAGE', purpose: '同步完整性、水位与故障调查',
    owner_roles: ['DATA_OWNER', 'ENGINEERING_OWNER', 'OPERATIONS_OWNER'],
  },
  throttled_runs: {
    authority: 'OPERATIONAL_AUDIT', purpose: '自动推荐节流与异常频率审计',
    owner_roles: ['ENGINEERING_OWNER', 'OPERATIONS_OWNER'],
  },
  recommendation_snapshots: {
    authority: 'DECISION_EVIDENCE', purpose: '回放、曝光、标签、评估与事故调查',
    owner_roles: ['BUSINESS_OWNER', 'DATA_OWNER', 'ENGINEERING_OWNER'],
  },
  raw_contexts: {
    authority: 'RESTRICTED_SOURCE_EVIDENCE', purpose: '授权提炼、事实证据与审计回放',
    owner_roles: ['DATA_OWNER', 'SECURITY_OWNER', 'BUSINESS_OWNER'],
  },
});

function tableExists(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function columns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(\`${table}\`)`).all().map((row) => row.name));
}

function supports(db, requirements) {
  return Object.entries(requirements).every(([table, required]) => {
    const available = columns(db, table);
    return required.every((column) => available.has(column));
  });
}

function count(db, requirements, sql) {
  if (!supports(db, requirements)) return null;
  return Number(db.prepare(sql).get().n || 0);
}

function summarize(db, { table, payload = [], time = null, where = '', required = [] }) {
  const availableColumns = columns(db, table);
  if (!availableColumns.size || required.some((column) => !availableColumns.has(column))) {
    return { table, available: false, rows: null, payload_bytes: null,
      oldest_at: null, newest_at: null, daily_growth: [] };
  }
  const suffix = where ? ` WHERE ${where}` : '';
  const payloadColumns = payload.filter((column) => availableColumns.has(column));
  const payloadSql = payloadColumns.length
    ? payloadColumns.map((column) => `COALESCE(length(CAST(\`${column}\` AS BLOB)),0)`).join(' + ')
    : '0';
  const timeSql = time && availableColumns.has(time)
    ? `MIN(\`${time}\`) oldest_at, MAX(\`${time}\`) newest_at` : 'NULL oldest_at, NULL newest_at';
  const row = db.prepare(`SELECT COUNT(*) rows, COALESCE(SUM(${payloadSql}),0) payload_bytes,
    ${timeSql} FROM \`${table}\`${suffix}`).get();
  let dailyGrowth = [];
  if (time && availableColumns.has(time)) {
    dailyGrowth = db.prepare(`SELECT substr(\`${time}\`,1,10) day, COUNT(*) rows
      FROM \`${table}\`${suffix}${suffix ? ' AND' : ' WHERE'} \`${time}\` IS NOT NULL
      GROUP BY substr(\`${time}\`,1,10) ORDER BY day DESC LIMIT 30`).all().reverse();
  }
  return { table, available: true, rows: Number(row.rows),
    payload_bytes: Number(row.payload_bytes), oldest_at: row.oldest_at || null,
    newest_at: row.newest_at || null,
    daily_growth: dailyGrowth.map((item) => ({ day: item.day, rows: Number(item.rows) })) };
}

function governed(name, values) {
  const policy = CATEGORY_POLICY[name];
  return {
    ...values,
    authority: policy.authority,
    purpose: policy.purpose,
    owner: { roles: policy.owner_roles, assignment_status: 'UNASSIGNED' },
    retention: { ttl_status: 'UNAPPROVED', ttl_days: null },
    recovery: { required: true, status: 'UNVERIFIED' },
    deletion_ready: false,
    blockers: [...BLOCKERS],
  };
}

function fieldReports(db) {
  return governed('ttc_field_reports', {
    summary: summarize(db, { table: 'ttc_field_reports', payload: ['report_json'],
      time: 'created_at' }),
    references: {
      parent_sync_runs: count(db,
        { ttc_field_reports: ['sync_id'], sync_runs: ['sync_id'] },
        `SELECT COUNT(DISTINCT f.sync_id) n FROM ttc_field_reports f
         JOIN sync_runs s ON s.sync_id=f.sync_id`),
      duplicate_payload_rows: count(db,
        { ttc_field_reports: ['consultant_id', 'schema_version', 'report_json'] },
        `SELECT COALESCE(SUM(n-1),0) n FROM (
           SELECT COUNT(*) n FROM ttc_field_reports
           GROUP BY consultant_id, schema_version, report_json HAVING COUNT(*)>1)`),
    },
  });
}

function syncRuns(db) {
  return governed('sync_runs', {
    summary: summarize(db, { table: 'sync_runs', payload: ['errors'], time: 'started_at' }),
    references: {
      current_job_facts: count(db, { sync_runs: ['sync_id'], job_facts: ['sync_id'] },
        `SELECT COUNT(DISTINCT s.sync_id) n FROM sync_runs s
         JOIN job_facts j ON j.sync_id=s.sync_id`),
      field_reports: count(db, { sync_runs: ['sync_id'], ttc_field_reports: ['sync_id'] },
        `SELECT COUNT(DISTINCT s.sync_id) n FROM sync_runs s
         JOIN ttc_field_reports f ON f.sync_id=s.sync_id`),
      decision_run_snapshots: count(db,
        { sync_runs: ['sync_id'], decision_runs: ['snapshot_id'] },
        `SELECT COUNT(*) n FROM decision_runs d JOIN sync_runs s ON s.sync_id=d.snapshot_id`),
    },
  });
}

function throttledRuns(db) {
  const statuses = "status IN ('SKIPPED_THROTTLED','SKIPPED_UNCHANGED')";
  return governed('throttled_runs', {
    summary: summarize(db, { table: 'decision_runs', time: 'created_at',
      where: statuses, required: ['status'] }),
    references: {
      unexpected_recommendations: count(db,
        { decision_runs: ['run_id', 'status'], recommendations: ['run_id'] },
        `SELECT COUNT(*) n FROM recommendations r JOIN decision_runs d ON d.run_id=r.run_id
         WHERE ${statuses}`),
    },
  });
}

function recommendationSnapshots(db) {
  return governed('recommendation_snapshots', {
    summary: summarize(db, { table: 'recommendations',
      payload: ['reasons_json', 'risks_json', 'evidence_refs_json', 'breakdown_json',
        'feature_snapshot_json'], time: 'created_at' }),
    capabilities: {
      feature_snapshot_column: supports(db, { recommendations: ['feature_snapshot_json'] }),
      feedback_events_table: supports(db, { recommendation_feedback_events: ['decision_id'] }),
    },
    feature_snapshots_missing: count(db, { recommendations: ['feature_snapshot_json'] },
      `SELECT COUNT(*) n FROM recommendations
       WHERE feature_snapshot_json IS NULL OR trim(feature_snapshot_json)=''`),
    references: {
      impressions: count(db,
        { recommendations: ['decision_id'], recommendation_impressions: ['decision_id'] },
        `SELECT COUNT(DISTINCT r.decision_id) n FROM recommendations r
         JOIN recommendation_impressions i ON i.decision_id=r.decision_id`),
      served_impressions: count(db,
        { recommendations: ['decision_id'], recommendation_impressions: ['decision_id', 'served_at'] },
        `SELECT COUNT(DISTINCT r.decision_id) n FROM recommendations r
         JOIN recommendation_impressions i ON i.decision_id=r.decision_id
         WHERE i.served_at IS NOT NULL`),
      business_outcomes: count(db,
        { recommendations: ['decision_id'], job_outcomes: ['decision_id'] },
        `SELECT COUNT(DISTINCT r.decision_id) n FROM recommendations r
         JOIN job_outcomes o ON o.decision_id=r.decision_id`),
      decision_events: count(db,
        { recommendations: ['decision_id'], decision_events: ['decision_id'] },
        `SELECT COUNT(DISTINCT r.decision_id) n FROM recommendations r
         JOIN decision_events e ON e.decision_id=r.decision_id`),
      feedback_events: count(db,
        { recommendations: ['decision_id'], recommendation_feedback_events: ['decision_id'] },
        `SELECT COUNT(DISTINCT r.decision_id) n FROM recommendations r
         JOIN recommendation_feedback_events f ON f.decision_id=r.decision_id`),
    },
  });
}

function rawContexts(db) {
  const tables = RAW_CONTEXT_TABLES.map((definition) => summarize(db, definition));
  return governed('raw_contexts', {
    summary: {
      available_tables: tables.filter((table) => table.available).length,
      rows: tables.reduce((sum, table) => sum + (table.rows || 0), 0),
      payload_bytes: tables.reduce((sum, table) => sum + (table.payload_bytes || 0), 0),
    },
    tables,
  });
}

export function buildRetentionInventory(db, { generatedAt = new Date().toISOString() } = {}) {
  return {
    contract_version: 'retention-inventory-v1',
    generated_at: generatedAt,
    read_only: true,
    content_values_emitted: false,
    deletion_candidates_emitted: false,
    categories: {
      ttc_field_reports: fieldReports(db),
      sync_runs: syncRuns(db),
      throttled_runs: throttledRuns(db),
      recommendation_snapshots: recommendationSnapshots(db),
      raw_contexts: rawContexts(db),
    },
    existing_cleanup_paths: [
      { path: 'src/recommend.js business transaction', status: 'IMPLICIT_DELETE_REMOVED' },
      { path: 'bin/brainx-retention.mjs --apply', status: 'DISABLED' },
    ],
  };
}
