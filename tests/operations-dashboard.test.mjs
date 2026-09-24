import assert from 'node:assert/strict';
import test from 'node:test';

import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { signSession } from '../src/session.js';
import {
  OPS_METRIC_VERSION,
  appendOperationsEvent,
  projectOperationsDashboard,
  readOperationsDashboard,
  recordBackupEvidence,
  traceOperationsMetric,
} from '../src/operations-dashboard.js';

const at = (hour) => `2026-09-24T${String(hour).padStart(2, '0')}:00:00.000Z`;

function event(db, key, source, sourceId, eventType, payload = {}, options = {}) {
  return appendOperationsEvent(db, {
    tenantId: 'brainx', eventKey: key, sourceType: source, sourceId,
    eventType, mode: options.mode || 'LIVE', occurredAt: options.occurredAt || at(1),
    receivedAt: options.receivedAt || options.occurredAt || at(1),
    correctionOf: options.correctionOf || null, payload,
  });
}

function seedProjectionEvents(db) {
  event(db, 'sync-1', 'sync', 'sync-1', 'SYNC_COMPLETED', {
    complete: true, rows_read: 20, rows_expected: 20 });
  event(db, 'job-done', 'integration_job', 'job-1', 'JOB_SUCCEEDED', {
    status: 'SUCCEEDED' }, { occurredAt: at(3), receivedAt: at(3) });
  event(db, 'job-late-running', 'integration_job', 'job-1', 'JOB_RUNNING', {
    status: 'RUNNING' }, { occurredAt: at(2), receivedAt: at(4) });
  event(db, 'live-run', 'ranking_run', 'run-live', 'RANKING_PUBLISHED', {
    status: 'PUBLISHED', eligible_count: 20 }, { occurredAt: at(3) });
  event(db, 'live-item', 'ranking_item', 'decision-1', 'RANKING_ITEM', {
    run_id: 'run-live', rank: 1 }, { occurredAt: at(3) });
  event(db, 'usage-live', 'usage', 'call-live', 'USAGE_SUCCEEDED', {
    status: 'SUCCEEDED', usage_status: 'KNOWN', total_tokens: 120,
    estimated_cost_micros: 360, latency_ms: 800 }, { occurredAt: at(3) });
  event(db, 'usage-shadow', 'usage', 'call-shadow', 'USAGE_SUCCEEDED', {
    status: 'SUCCEEDED', usage_status: 'KNOWN', total_tokens: 80,
    estimated_cost_micros: 240, latency_ms: 1200 }, { mode: 'SHADOW', occurredAt: at(3) });
  event(db, 'usage-unknown', 'usage', 'call-unknown', 'USAGE_FAILED', {
    status: 'FAILED', usage_status: 'UNKNOWN', total_tokens: null,
    estimated_cost_micros: null, latency_ms: 2000 }, { occurredAt: at(4) });
  event(db, 'served-1', 'exposure', 'served-1', 'EXPOSURE_SERVED', {
    decision_id: 'decision-1', position: 1 }, { occurredAt: at(4) });
  event(db, 'visible-1', 'exposure', 'visible-1', 'EXPOSURE_VISIBLE', {
    decision_id: 'decision-1', position: 1 }, { occurredAt: at(4) });
  event(db, 'accepted-1', 'decision', 'accepted-1', 'DECISION_ACCEPTED', {
    decision_id: 'decision-1' }, { occurredAt: at(5) });
  event(db, 'outcome-original', 'business_outcome', 'case-event-1', 'OUTCOME_RECORDED', {
    decision_id: 'decision-1', stage: '面试', attributed: true }, { occurredAt: at(6) });
  event(db, 'outcome-correction', 'business_outcome', 'case-event-2', 'OUTCOME_CORRECTED', {
    decision_id: 'decision-1', stage: 'Offer', attributed: true }, {
    correctionOf: 'case-event-1', occurredAt: at(7), receivedAt: at(8),
  });
  event(db, 'fact-a', 'job_fact_version', 'fact-a', 'JOB_FACT_VERSION', {
    job_id: 'job-a', version: 1 }, { occurredAt: at(1) });
  event(db, 'fact-b', 'job_fact_version', 'fact-b', 'JOB_FACT_VERSION', {
    job_id: 'job-b', version: 1 }, { occurredAt: at(2) });
  event(db, 'shadow-1', 'shadow_evaluation', 'shadow-1', 'SHADOW_COMPLETED', {
    status: 'SHADOW_COMPLETED', metrics: { top_10_overlap: 0.6, ndcg_delta: 0.08,
      labeled_candidates: 12, label_coverage: 0.75, hard_violation_count: 0 } },
  { mode: 'SHADOW', occurredAt: at(8) });
  recordBackupEvidence(db, { tenantId: 'brainx', backupId: 'backup-1', status: 'SUCCEEDED',
    sizeBytes: 4096, restoreVerified: true, startedAt: at(8), completedAt: at(9) });
}

test('事件投影对重复、迟到旧状态和结果更正幂等，重建与增量一致', () => {
  const db = openDb(':memory:');
  seedProjectionEvents(db);
  assert.equal(event(db, 'served-1', 'exposure', 'served-1', 'EXPOSURE_SERVED', {
    decision_id: 'decision-1' }).created, false);
  assert.throws(() => event(db, 'served-1', 'decision', 'different-source', 'DECISION_ACCEPTED'),
    /OPERATIONS_EVENT_KEY_CONFLICT/);
  const projected = projectOperationsDashboard(db, {
    tenantId: 'brainx', at: at(10), rebuild: false,
  });
  assert.equal(projected.metric_version, OPS_METRIC_VERSION);
  assert.equal(projected.freshness.backlog, 0);
  assert.equal(projected.operations.jobs.succeeded, 1);
  assert.equal(projected.operations.jobs.running, 0, '迟到旧状态不能覆盖成功态');
  assert.deepEqual(projected.funnel, {
    served: 1, visible: 1, accepted: 1, interview: 0, offer: 1, onboard: 0,
    shadow_exposures: 0, shadow_outcomes: 0,
  });
  assert.equal(projected.cost.live.calls, 2);
  assert.equal(projected.cost.live.known_calls, 1);
  assert.equal(projected.cost.live.total_tokens, 120);
  assert.equal(projected.cost.shadow.calls, 1);
  assert.equal(projected.cost.shadow.total_tokens, 80);
  assert.equal(projected.ranking.shadow.avg_top_10_overlap, 0.6);
  assert.equal(projected.capacity.current_jobs, 2);
  assert.equal(projected.backup.status, 'SUCCEEDED');
  assert.equal(projected.sample_maturity.attributed_decisions, 1);

  const before = structuredClone(projected);
  const rebuilt = projectOperationsDashboard(db, {
    tenantId: 'brainx', at: at(10), rebuild: true,
  });
  for (const key of ['operations', 'funnel', 'ranking', 'cost', 'capacity', 'backup', 'sample_maturity']) {
    assert.deepEqual(rebuilt[key], before[key], key);
  }
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM operations_projection_events`).get().n, 17);
  db.close();
});

test('在线来源触发器只写窄事件，任务与备份状态变化可增量消费', () => {
  const db = openDb(':memory:');
  db.prepare(`INSERT INTO integration_jobs
    (job_id,tenant_id,consultant_id,kind,idempotency_key,status,payload_json,attempts,
     max_attempts,cost_units,cost_limit,requested_at,updated_at)
    VALUES ('job-trigger','brainx','felix','SEARCH','job-trigger-key','PENDING','{}',0,3,0,0,?,?)`)
    .run(at(1), at(1));
  db.prepare(`UPDATE integration_jobs SET status='SUCCEEDED',completed_at=?,updated_at=?
    WHERE job_id='job-trigger'`).run(at(2), at(2));
  recordBackupEvidence(db, { tenantId: 'brainx', backupId: 'backup-trigger', status: 'RUNNING',
    startedAt: at(2) });
  recordBackupEvidence(db, { tenantId: 'brainx', backupId: 'backup-trigger', status: 'SUCCEEDED',
    sizeBytes: 2048, restoreVerified: false, startedAt: at(2), completedAt: at(3) });
  assert.throws(() => recordBackupEvidence(db, { tenantId: 'another',
    backupId: 'backup-trigger', status: 'FAILED', startedAt: at(2), completedAt: at(3) }),
  /BACKUP_TENANT_CONFLICT/);
  const rows = db.prepare(`SELECT source_type,event_type,payload_json
    FROM operations_projection_events ORDER BY sequence`).all();
  assert.deepEqual(rows.map((row) => [row.source_type, row.event_type]), [
    ['integration_job', 'JOB_PENDING'], ['integration_job', 'JOB_SUCCEEDED'],
    ['backup', 'BACKUP_RUNNING'], ['backup', 'BACKUP_SUCCEEDED'],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /payload_json.*consultant|secret|token|prompt/i);
  const snapshot = projectOperationsDashboard(db, { tenantId: 'brainx', at: at(4) });
  assert.equal(snapshot.operations.jobs.succeeded, 1);
  assert.equal(snapshot.backup.status, 'SUCCEEDED');
  db.close();
});

test('快照只读投影并提供有界脱敏追溯，不返回 payload 或主体', () => {
  const db = openDb(':memory:');
  seedProjectionEvents(db);
  projectOperationsDashboard(db, { tenantId: 'brainx', at: at(10) });
  const snapshot = readOperationsDashboard(db, 'brainx', { at: at(11) });
  assert.equal(snapshot.schema_version, 'operations_dashboard.v1');
  assert.equal(snapshot.freshness.metric_version, OPS_METRIC_VERSION);
  const trace = traceOperationsMetric(db, { tenantId: 'brainx', metric: 'funnel', limit: 100 });
  assert.ok(trace.items.length >= 4 && trace.items.length <= 20);
  assert.deepEqual(Object.keys(trace.items[0]).sort(), ['event_id', 'event_type', 'mode', 'occurred_at']);
  assert.doesNotMatch(JSON.stringify(trace), /payload|consultant|prompt|token|secret/);
  assert.throws(() => traceOperationsMetric(db, {
    tenantId: 'brainx', metric: 'arbitrary_sql', limit: 1,
  }), /TRACE_METRIC_INVALID/);
  db.close();
});

const cookie = (consultant) => ({
  Cookie: `brainx_session=${encodeURIComponent(signSession(consultant, `ou_${consultant}`))}`,
  'Content-Type': 'application/json',
});

test('运营看板读取、投影和追溯独立验证管理员权限', async () => {
  const db = openDb(':memory:');
  seedProjectionEvents(db);
  const server = createServer(db, { operationsAdmins: ['york'] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const denied = await fetch(`${base}/api/v1/admin/operations/dashboard`, { headers: cookie('mia') });
    assert.equal(denied.status, 403);
    const projected = await fetch(`${base}/api/v1/admin/operations/project`, {
      method: 'POST', headers: cookie('york'), body: JSON.stringify({ rebuild: false }),
    });
    assert.equal(projected.status, 200);
    const allowed = await fetch(`${base}/api/v1/admin/operations/dashboard`, { headers: cookie('york') });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).funnel.offer, 1);
    const trace = await fetch(`${base}/api/v1/admin/operations/events?metric=funnel&limit=20`, {
      headers: cookie('york'),
    });
    assert.equal(trace.status, 200);
    assert.doesNotMatch(await trace.text(), /payload_json|consultant_id/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
  }
});
