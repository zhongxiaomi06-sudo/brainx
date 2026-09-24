/** 阶段 10：归一事件消费者、运营读模型与脱敏追溯（specs/034）。 */
import { now, uuid } from './db.js';

export const OPS_METRIC_VERSION = 'operations-dashboard-v1';
const SCHEMA_VERSION = 'operations_dashboard.v1';
const TRACE_SOURCES = {
  freshness: ['sync', 'integration_job'],
  operations: ['sync', 'integration_job', 'push'],
  funnel: ['exposure', 'decision', 'business_outcome'],
  ranking: ['ranking_run', 'ranking_item', 'shadow_evaluation'],
  cost: ['usage'], capacity: ['job_fact_version'], backup: ['backup'],
  sample_maturity: ['exposure', 'business_outcome'],
};

function parse(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function iso(value, field) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new TypeError(`${field} 必须是 ISO 时间`);
  return new Date(time).toISOString();
}

function eventMode(value) {
  if (!['LIVE', 'SHADOW', 'SYSTEM'].includes(value)) throw new TypeError('mode 不合法');
  return value;
}

export function appendOperationsEvent(db, input) {
  for (const key of ['tenantId', 'eventKey', 'sourceType', 'sourceId', 'eventType']) {
    if (!String(input[key] || '').trim()) throw new TypeError(`${key} 不能为空`);
  }
  const prior = db.prepare(`SELECT sequence,tenant_id,source_type,source_id,event_type
    FROM operations_projection_events WHERE event_key=?`)
    .get(input.eventKey);
  if (prior) {
    const sameIdentity = prior.tenant_id === input.tenantId
      && prior.source_type === input.sourceType && prior.source_id === input.sourceId
      && prior.event_type === input.eventType;
    if (!sameIdentity) throw new TypeError('OPERATIONS_EVENT_KEY_CONFLICT');
    return { created: false, sequence: prior.sequence };
  }
  const occurred = iso(input.occurredAt, 'occurredAt');
  const received = iso(input.receivedAt || input.occurredAt, 'receivedAt');
  const result = db.prepare(`INSERT INTO operations_projection_events
    (event_key,tenant_id,source_type,source_id,event_type,mode,occurred_at,received_at,
     correction_of,payload_json,ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.eventKey, input.tenantId, input.sourceType, input.sourceId, input.eventType,
    eventMode(input.mode || 'SYSTEM'), occurred, received, input.correctionOf || null,
    JSON.stringify(input.payload || {}), now(),
  );
  return { created: true, sequence: Number(result.lastInsertRowid) };
}

export function recordBackupEvidence(db, input) {
  if (!['RUNNING', 'SUCCEEDED', 'FAILED'].includes(input.status)) {
    throw new TypeError('BACKUP_STATUS_INVALID');
  }
  const size = input.sizeBytes == null ? null : Number(input.sizeBytes);
  if (size != null && (!Number.isInteger(size) || size < 0)) throw new TypeError('BACKUP_SIZE_INVALID');
  const restore = input.restoreVerified == null ? null : input.restoreVerified ? 1 : 0;
  const started = iso(input.startedAt, 'startedAt');
  const completed = input.completedAt ? iso(input.completedAt, 'completedAt') : null;
  const prior = db.prepare('SELECT tenant_id,status FROM operations_backup_evidence WHERE backup_id=?')
    .get(input.backupId);
  if (prior && prior.tenant_id !== input.tenantId) throw new TypeError('BACKUP_TENANT_CONFLICT');
  db.prepare(`INSERT INTO operations_backup_evidence
    (backup_id,tenant_id,status,size_bytes,restore_verified,started_at,completed_at,recorded_at)
    VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(backup_id) DO UPDATE SET
    status=excluded.status,size_bytes=excluded.size_bytes,
    restore_verified=excluded.restore_verified,completed_at=excluded.completed_at,
    recorded_at=excluded.recorded_at`).run(input.backupId, input.tenantId, input.status, size,
    restore, started, completed, now());
  return { created: !prior, updated: !!prior && prior.status !== input.status,
    backup_id: input.backupId };
}

function entityKey(db, event) {
  if (event.source_type === 'business_outcome' && event.correction_of) {
    const corrected = db.prepare(`SELECT entity_key FROM operations_projection_entities
      WHERE tenant_id=? AND source_type='business_outcome' AND source_id=?`)
      .get(event.tenant_id, event.correction_of);
    if (corrected) return corrected.entity_key;
  }
  const logicalId = event.source_type === 'business_outcome'
    ? (event.correction_of || event.source_id) : event.source_id;
  return `${event.source_type}:${logicalId}`;
}

function applyEvent(db, event) {
  const key = entityKey(db, event);
  const current = db.prepare(`SELECT occurred_at,sequence FROM operations_projection_entities
    WHERE tenant_id=? AND entity_key=?`).get(event.tenant_id, key);
  const corrected = event.source_type === 'business_outcome' && !!event.correction_of;
  if (current && !corrected && String(current.occurred_at) > String(event.occurred_at)) return;
  db.prepare(`INSERT INTO operations_projection_entities
    (tenant_id,entity_key,source_type,source_id,event_key,event_type,mode,occurred_at,
     received_at,sequence,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,entity_key) DO UPDATE SET
      source_id=excluded.source_id,event_key=excluded.event_key,event_type=excluded.event_type,
      mode=excluded.mode,occurred_at=excluded.occurred_at,received_at=excluded.received_at,
      sequence=excluded.sequence,payload_json=excluded.payload_json`).run(
    event.tenant_id, key, event.source_type, event.source_id, event.event_key,
    event.event_type, event.mode, event.occurred_at, event.received_at,
    event.sequence, event.payload_json,
  );
}

const countStatus = (rows, statuses) => Object.fromEntries(statuses.map((status) => [status.toLowerCase(),
  rows.filter((row) => row.payload.status === status).length]));

function p95(values) {
  const known = values.filter(Number.isFinite).sort((a, b) => a - b);
  return known.length ? known[Math.max(0, Math.ceil(known.length * 0.95) - 1)] : null;
}

function costSummary(rows) {
  const known = rows.filter((row) => row.payload.usage_status === 'KNOWN');
  const sumKnown = (field) => {
    const values = known.map((row) => row.payload[field]).filter((value) => Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  return {
    calls: rows.length, known_calls: known.length,
    total_tokens: sumKnown('total_tokens'), estimated_cost_micros: sumKnown('estimated_cost_micros'),
    failed_calls: rows.filter((row) => row.payload.status === 'FAILED').length,
    p95_latency_ms: p95(rows.map((row) => row.payload.latency_ms)),
  };
}

function average(values) {
  const known = values.filter(Number.isFinite);
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function shadowMetrics(row) {
  const metrics = row.payload.metrics;
  return typeof metrics === 'string' ? parse(metrics) : (metrics || {});
}

function stageKind(value) {
  const stage = String(value || '').toLowerCase();
  if (stage.includes('面试') || stage === 'interview') return 'interview';
  if (stage.includes('offer')) return 'offer';
  if (stage.includes('onboard') || stage.includes('入职') || stage === 'placed') return 'onboard';
  return null;
}

function sourceDefinitions() {
  return [
    { metric: 'operations', sources: ['sync', 'integration_job', 'push'], grain: '同步批次 / 任务 / 投递' },
    { metric: 'funnel', sources: ['exposure', 'decision', 'business_outcome'], grain: '唯一决策 / 逻辑结果' },
    { metric: 'ranking', sources: ['ranking_run', 'ranking_item', 'shadow_evaluation'], grain: '运行 / 原序项' },
    { metric: 'cost', sources: ['usage'], grain: '模型调用尝试，按 LIVE/SHADOW' },
    { metric: 'capacity', sources: ['job_fact_version'], grain: '职位 / 不可变事实版本' },
    { metric: 'backup', sources: ['backup'], grain: '外部登记的备份证据' },
  ];
}

function buildSnapshot(rows, freshness) {
  const by = (source) => rows.filter((row) => row.source_type === source);
  const syncRows = by('sync');
  const jobRows = by('integration_job');
  const pushRows = by('push');
  const liveRuns = by('ranking_run').filter((row) => row.mode === 'LIVE');
  const items = by('ranking_item').filter((row) => row.mode === 'LIVE');
  const shadows = by('shadow_evaluation');
  const exposures = by('exposure');
  const liveExposures = exposures.filter((row) => row.mode !== 'SHADOW');
  const outcomes = by('business_outcome');
  const liveOutcomes = outcomes.filter((row) => row.mode !== 'SHADOW');
  const accepted = by('decision').filter((row) => row.event_type === 'DECISION_ACCEPTED');
  const unique = (itemsIn, key) => new Set(itemsIn.map((row) => row.payload[key]).filter(Boolean)).size;
  const stageCounts = { interview: 0, offer: 0, onboard: 0 };
  for (const row of liveOutcomes) {
    const kind = stageKind(row.payload.stage);
    if (kind) stageCounts[kind] += 1;
  }
  const facts = by('job_fact_version');
  const firstDay = new Map();
  for (const row of facts) {
    const job = row.payload.job_id;
    const day = String(row.occurred_at).slice(0, 10);
    if (job && (!firstDay.has(job) || day < firstDay.get(job))) firstDay.set(job, day);
  }
  const daily = {};
  for (const day of firstDay.values()) daily[day] = (daily[day] || 0) + 1;
  const backups = by('backup').sort((a, b) => b.sequence - a.sequence);
  const backup = backups[0]?.payload || {};
  const usage = by('usage');
  const shadowValues = shadows.map(shadowMetrics);
  const exposedDecisions = unique(liveExposures.filter((row) => row.event_type === 'EXPOSURE_SERVED'), 'decision_id');
  const attributedDecisions = unique(liveOutcomes.filter((row) => !!row.payload.attributed), 'decision_id');
  const caveats = [];
  if (!backups.length) caveats.push('尚未登记备份或恢复验证证据');
  if (usage.some((row) => row.payload.usage_status !== 'KNOWN')) caveats.push('部分模型调用用量未知，未按 0 填充');
  return {
    schema_version: SCHEMA_VERSION,
    metric_version: OPS_METRIC_VERSION,
    freshness,
    operations: {
      sync: {
        complete: syncRows.filter((row) => row.event_type === 'SYNC_COMPLETED').length,
        incomplete: syncRows.filter((row) => row.event_type === 'SYNC_INCOMPLETE').length,
        failed: syncRows.filter((row) => row.event_type === 'SYNC_FAILED').length,
      },
      jobs: countStatus(jobRows, ['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
      delivery_failed: pushRows.filter((row) => row.payload.status === 'FAILED').length,
    },
    funnel: {
      served: unique(liveExposures.filter((row) => row.event_type === 'EXPOSURE_SERVED'), 'decision_id'),
      visible: unique(liveExposures.filter((row) => row.event_type === 'EXPOSURE_VISIBLE'), 'decision_id'),
      accepted: unique(accepted, 'decision_id'), ...stageCounts,
      shadow_exposures: exposures.filter((row) => row.mode === 'SHADOW').length,
      shadow_outcomes: outcomes.filter((row) => row.mode === 'SHADOW').length,
    },
    ranking: {
      live: {
        published: liveRuns.filter((row) => row.payload.status === 'PUBLISHED').length,
        failed: liveRuns.filter((row) => row.payload.status === 'FAILED').length,
        abstained: liveRuns.filter((row) => row.payload.status === 'ABSTAINED').length,
        recommendation_items: items.length,
      },
      shadow: {
        completed: shadows.filter((row) => row.payload.status === 'SHADOW_COMPLETED').length,
        failed: shadows.filter((row) => row.payload.status === 'FAILED').length,
        avg_top_10_overlap: average(shadowValues.map((value) => value.top_10_overlap)),
        avg_ndcg_delta: average(shadowValues.map((value) => value.ndcg_delta)),
        labeled_candidates: shadowValues.reduce((sum, value) => sum + Number(value.labeled_candidates || 0), 0),
        hard_violations: shadowValues.reduce((sum, value) => sum + Number(value.hard_violation_count || 0), 0),
      },
    },
    cost: {
      live: costSummary(usage.filter((row) => row.mode !== 'SHADOW')),
      shadow: costSummary(usage.filter((row) => row.mode === 'SHADOW')),
    },
    capacity: {
      current_jobs: new Set(facts.map((row) => row.payload.job_id).filter(Boolean)).size,
      fact_versions: facts.length,
      daily_growth: Object.entries(daily).sort().map(([date, new_jobs]) => ({ date, new_jobs })),
    },
    backup: backups.length ? {
      status: backup.status, completed_at: backup.completed_at || null,
      size_bytes: backup.size_bytes ?? null,
      restore_verified: backup.restore_verified == null ? null : !!backup.restore_verified,
    } : { status: 'NOT_REPORTED', completed_at: null, size_bytes: null, restore_verified: null },
    sample_maturity: {
      exposed_decisions: exposedDecisions, attributed_decisions: attributedDecisions,
      rate: exposedDecisions ? attributedDecisions / exposedDecisions : null,
    },
    sources: sourceDefinitions(), caveats,
  };
}

function rowsForSnapshot(db, tenantId) {
  return db.prepare(`SELECT * FROM operations_projection_entities
    WHERE tenant_id=? ORDER BY sequence`).all(tenantId)
    .map((row) => ({ ...row, payload: parse(row.payload_json) }));
}

export function projectOperationsDashboard(db, {
  tenantId = 'brainx', rebuild = false, at = now(), limit = 1000,
} = {}) {
  const projectedAt = iso(at, 'at');
  const checkpoint = db.prepare(`SELECT * FROM operations_projection_checkpoints WHERE tenant_id=?`)
    .get(tenantId);
  const from = rebuild ? 0 : Number(checkpoint?.last_sequence || 0);
  const runId = `opr_${uuid()}`;
  db.prepare(`INSERT INTO operations_projection_runs
    (projection_run_id,tenant_id,mode,status,from_sequence,started_at)
    VALUES (?,?,?,'RUNNING',?,?)`).run(runId, tenantId, rebuild ? 'REBUILD' : 'INCREMENTAL', from, projectedAt);
  db.exec('BEGIN');
  try {
    if (rebuild) {
      db.prepare('DELETE FROM operations_projection_entities WHERE tenant_id=?').run(tenantId);
      db.prepare('DELETE FROM operations_projection_checkpoints WHERE tenant_id=?').run(tenantId);
      db.prepare('DELETE FROM operations_dashboard_snapshots WHERE tenant_id=?').run(tenantId);
    }
    const events = db.prepare(`SELECT * FROM operations_projection_events
      WHERE tenant_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(tenantId, from, Math.max(1, Math.min(Number(limit) || 1000, 10000)));
    for (const item of events) applyEvent(db, item);
    const last = events.at(-1)?.sequence || from;
    const maximum = db.prepare(`SELECT COALESCE(MAX(sequence),0) n FROM operations_projection_events
      WHERE tenant_id=?`).get(tenantId).n;
    const backlog = Math.max(0, Number(maximum) - Number(last));
    const entities = rowsForSnapshot(db, tenantId);
    const lastEvent = entities.reduce((value, row) => !value || row.occurred_at > value ? row.occurred_at : value, null);
    const lag = lastEvent ? Math.max(0, Math.floor((Date.parse(projectedAt) - Date.parse(lastEvent)) / 1000)) : null;
    const freshness = { metric_version: OPS_METRIC_VERSION, status: backlog ? 'BACKLOG' : entities.length ? 'READY' : 'EMPTY',
      checkpoint: Number(last), max_sequence: Number(maximum), backlog,
      last_event_at: lastEvent, projected_at: projectedAt, lag_seconds: lag };
    const snapshot = buildSnapshot(entities, freshness);
    db.prepare(`INSERT INTO operations_projection_checkpoints
      (tenant_id,metric_version,last_sequence,status,error_count,last_error_code,updated_at)
      VALUES (?,?,?,?,0,NULL,?) ON CONFLICT(tenant_id) DO UPDATE SET
      metric_version=excluded.metric_version,last_sequence=excluded.last_sequence,status=excluded.status,
      error_count=0,last_error_code=NULL,updated_at=excluded.updated_at`)
      .run(tenantId, OPS_METRIC_VERSION, last, freshness.status, projectedAt);
    db.prepare(`INSERT INTO operations_dashboard_snapshots
      (tenant_id,schema_version,metric_version,checkpoint,event_count,payload_json,projected_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET
      schema_version=excluded.schema_version,metric_version=excluded.metric_version,
      checkpoint=excluded.checkpoint,event_count=excluded.event_count,
      payload_json=excluded.payload_json,projected_at=excluded.projected_at`)
      .run(tenantId, SCHEMA_VERSION, OPS_METRIC_VERSION, last, entities.length,
        JSON.stringify(snapshot), projectedAt);
    db.prepare(`UPDATE operations_projection_runs SET status='SUCCEEDED',to_sequence=?,
      event_count=?,completed_at=? WHERE projection_run_id=?`).run(last, events.length, projectedAt, runId);
    db.exec('COMMIT');
    return snapshot;
  } catch (error) {
    db.exec('ROLLBACK');
    const code = String(error?.code || error?.name || 'PROJECTION_FAILED').slice(0, 80);
    db.prepare(`UPDATE operations_projection_runs SET status='FAILED',completed_at=?,error_code=?
      WHERE projection_run_id=?`).run(projectedAt, code, runId);
    db.prepare(`INSERT INTO operations_projection_checkpoints
      (tenant_id,metric_version,last_sequence,status,error_count,last_error_code,updated_at)
      VALUES (?,?,?,'FAILED',1,?,?) ON CONFLICT(tenant_id) DO UPDATE SET
      status='FAILED',error_count=error_count+1,last_error_code=excluded.last_error_code,
      updated_at=excluded.updated_at`).run(tenantId, OPS_METRIC_VERSION, from, code, projectedAt);
    throw error;
  }
}

function emptySnapshot() {
  return buildSnapshot([], { metric_version: OPS_METRIC_VERSION, status: 'EMPTY', checkpoint: 0,
    max_sequence: 0, backlog: 0, last_event_at: null, projected_at: null, lag_seconds: null });
}

export function readOperationsDashboard(db, tenantId = 'brainx', {
  at = now(), staleAfterSeconds = 900,
} = {}) {
  const row = db.prepare(`SELECT payload_json FROM operations_dashboard_snapshots WHERE tenant_id=?`)
    .get(tenantId);
  if (!row) return emptySnapshot();
  const snapshot = parse(row.payload_json, emptySnapshot());
  const checkpoint = db.prepare(`SELECT * FROM operations_projection_checkpoints WHERE tenant_id=?`)
    .get(tenantId);
  const maximum = db.prepare(`SELECT COALESCE(MAX(sequence),0) n FROM operations_projection_events
    WHERE tenant_id=?`).get(tenantId).n;
  const backlog = Math.max(0, Number(maximum) - Number(checkpoint?.last_sequence || 0));
  const lag = snapshot.freshness.last_event_at
    ? Math.max(0, Math.floor((Date.parse(at) - Date.parse(snapshot.freshness.last_event_at)) / 1000)) : null;
  snapshot.freshness = { ...snapshot.freshness, checkpoint: Number(checkpoint?.last_sequence || 0),
    max_sequence: Number(maximum), backlog, lag_seconds: lag,
    status: checkpoint?.status === 'FAILED' ? 'FAILED' : backlog ? 'BACKLOG'
      : lag != null && lag > staleAfterSeconds ? 'STALE' : checkpoint?.status || 'EMPTY' };
  return snapshot;
}

export function traceOperationsMetric(db, { tenantId = 'brainx', metric, limit = 20 }) {
  const sources = TRACE_SOURCES[metric];
  if (!sources) throw new TypeError('TRACE_METRIC_INVALID');
  const bounded = Math.max(1, Math.min(Number(limit) || 20, 20));
  const marks = sources.map(() => '?').join(',');
  const rows = db.prepare(`SELECT event_key,event_type,mode,occurred_at
    FROM operations_projection_events WHERE tenant_id=? AND source_type IN (${marks})
    ORDER BY sequence DESC LIMIT ?`).all(tenantId, ...sources, bounded);
  return { metric, metric_version: OPS_METRIC_VERSION, items: rows.map((row) => ({
    event_id: row.event_key, event_type: row.event_type, mode: row.mode,
    occurred_at: row.occurred_at,
  })) };
}

export function startOperationsProjectionWorker(db, {
  tenantId = 'brainx', intervalMs = Number(process.env.BRAINX_OPERATIONS_INTERVAL_MS || 60000),
  log = console.log,
} = {}) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try { projectOperationsDashboard(db, { tenantId }); }
    catch (error) { log(`[operations] 投影失败: ${String(error?.message || error).slice(0, 120)}`); }
    finally { running = false; }
  };
  tick();
  const timer = setInterval(tick, Math.max(1000, intervalMs));
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}
