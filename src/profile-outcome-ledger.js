/** 主动画像、短期信号、真实曝光与 Case 结果账本（specs/029）。 */
import { now, uuid } from './db.js';
import { sha256, stableJson } from './job-source-contract.js';
import { consumeOnce } from './hub/consumer.js';
import { decisionReferenceIsValid } from './event-time.js';

const PROFILE_KEYS = [
  'profile_keywords', 'profile_note', 'excluded_companies', 'excluded_roles',
  'excluded_cities', 'capacity_limit',
];

function parseJson(value, fallback = {}) {
  try { return JSON.parse(value || '{}'); } catch { return fallback; }
}

function iso(value, field) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new TypeError(`${field} 必须是有效 ISO 时间`);
  return new Date(ms).toISOString();
}

export function canonicalActiveProfile(profile = {}) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    if (profile[key] !== undefined) out[key] = profile[key];
  }
  out.profile_keywords = Array.isArray(out.profile_keywords) ? out.profile_keywords : [];
  out.profile_note = String(out.profile_note || '');
  return out;
}

export function appendConsultantProfileVersion(db, {
  tenantId = 'brainx', consultantId, profile, changedBy = consultantId,
  reason = 'SELF_SERVICE', at = now(),
}) {
  const facts = canonicalActiveProfile(profile);
  const contentHash = sha256(facts);
  const latest = db.prepare(`SELECT * FROM consultant_profile_versions
    WHERE tenant_id=? AND consultant_id=? ORDER BY version DESC LIMIT 1`).get(tenantId, consultantId);
  if (latest?.content_hash === contentHash) {
    return { profile_version: latest.profile_version, version: latest.version, created: false };
  }
  const version = (latest?.version || 0) + 1;
  const profileVersion = `cpv_${sha256([tenantId, consultantId, version, contentHash]).slice(0, 28)}`;
  db.prepare(`INSERT INTO consultant_profile_versions
    (profile_version, tenant_id, consultant_id, version, profile_json, content_hash,
     changed_by, change_reason, effective_at, recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    profileVersion, tenantId, consultantId, version, stableJson(facts), contentHash,
    changedBy, reason, at, now(),
  );
  return { profile_version: profileVersion, version, created: true };
}

export function addConsultantSignal(db, input) {
  for (const field of ['tenantId', 'consultantId', 'signalType', 'source',
    'confidence', 'algorithmVersion', 'idempotencyKey']) {
    if (!String(input[field] || '').trim()) throw new TypeError(`${field} 不能为空`);
  }
  const sampleCount = Number(input.sampleCount);
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new TypeError('sampleCount 必须是非负整数');
  }
  const start = iso(input.windowStart, 'windowStart');
  const end = iso(input.windowEnd, 'windowEnd');
  const expires = iso(input.expiresAt, 'expiresAt');
  if (Date.parse(start) > Date.parse(end) || Date.parse(end) > Date.parse(expires)) {
    throw new TypeError('信号时间窗必须满足 start <= end <= expires');
  }
  const duplicate = db.prepare('SELECT * FROM consultant_signals WHERE idempotency_key=?')
    .get(input.idempotencyKey);
  if (duplicate) return { signal_id: duplicate.signal_id, created: false };
  const signalId = `csg_${uuid()}`;
  db.prepare(`INSERT INTO consultant_signals
    (signal_id, tenant_id, consultant_id, signal_type, value_json, source, sample_count,
     confidence, algorithm_version, window_start, window_end, expires_at, recorded_at, idempotency_key)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    signalId, input.tenantId, input.consultantId, input.signalType,
    JSON.stringify(input.value ?? null), input.source, sampleCount, input.confidence,
    input.algorithmVersion, start, end, expires, now(), input.idempotencyKey,
  );
  return { signal_id: signalId, created: true };
}

export function revokeConsultantSignal(db, { tenantId, consultantId, signalId, reason, at = now() }) {
  const result = db.prepare(`UPDATE consultant_signals SET revoked_at=?, revoke_reason=?
    WHERE signal_id=? AND tenant_id=? AND consultant_id=? AND revoked_at IS NULL`)
    .run(at, String(reason || 'revoked').slice(0, 120), signalId, tenantId, consultantId);
  return { revoked: result.changes === 1 };
}

export function currentProjectLoad(db, consultantId, at = now()) {
  const accepted = db.prepare(`SELECT COUNT(*) n FROM current_engagement
    WHERE consultant_id=? AND state='ACCEPTED'`).get(consultantId).n;
  const actions = db.prepare(`SELECT COUNT(*) n FROM commitment_actions
    WHERE consultant_id=? AND status IN ('OPEN','BLOCKED')`).get(consultantId).n;
  return { version: `load:${sha256([consultantId, accepted, actions]).slice(0, 20)}`,
    sampled_at: at, accepted_projects: accepted, active_actions: actions };
}

export function currentConsultantContext(db, { tenantId = 'brainx', consultantId, at = now() }) {
  const row = db.prepare('SELECT profile_json FROM consultants WHERE consultant_id=? AND active=1')
    .get(consultantId);
  if (!row) throw new Error('CONSULTANT_NOT_FOUND');
  const version = db.prepare(`SELECT profile_version, version, profile_json, effective_at
    FROM consultant_profile_versions WHERE tenant_id=? AND consultant_id=?
    ORDER BY version DESC LIMIT 1`).get(tenantId, consultantId);
  const signals = db.prepare(`SELECT * FROM consultant_signals
    WHERE tenant_id=? AND consultant_id=? AND revoked_at IS NULL AND expires_at>?
    ORDER BY recorded_at, signal_id`).all(tenantId, consultantId, at)
    .map((item) => ({ ...item, value: parseJson(item.value_json, null), value_json: undefined }));
  return {
    tenant_id: tenantId,
    consultant_id: consultantId,
    profile_version: version?.profile_version || null,
    profile: version ? parseJson(version.profile_json) : canonicalActiveProfile(parseJson(row.profile_json)),
    signals,
    load: currentProjectLoad(db, consultantId, at),
  };
}

export function recordRecommendationExposure(db, input) {
  const duplicate = db.prepare('SELECT * FROM recommendation_exposure_events WHERE exposure_event_id=?')
    .get(input.eventId);
  if (duplicate) {
    const sameEvent = duplicate.tenant_id === input.tenantId
      && duplicate.consultant_id === input.consultantId
      && duplicate.decision_id === input.decisionId
      && duplicate.event_type === input.eventType;
    return sameEvent
      ? { ok: true, already: true, exposure_event_id: duplicate.exposure_event_id }
      : { ok: false, status: 409, error: 'EXPOSURE_EVENT_ID_CONFLICT' };
  }
  if (!['SERVED', 'VISIBLE'].includes(input.eventType)) {
    return { ok: false, status: 422, error: 'INVALID_EXPOSURE_EVENT_TYPE' };
  }
  if (!String(input.channel || '').trim()) {
    return { ok: false, status: 422, error: 'INVALID_EXPOSURE_CHANNEL' };
  }
  const rec = db.prepare(`SELECT r.run_id, r.decision_id, r.project_id, r.rank, i.impression_id, i.propensity
    FROM recommendations r LEFT JOIN recommendation_impressions i ON i.decision_id=r.decision_id
    WHERE r.decision_id=? AND r.consultant_id=?`).get(input.decisionId, input.consultantId);
  if (!rec) return { ok: false, status: 404, error: 'RECOMMENDATION_NOT_FOUND' };
  const occurred = iso(input.occurredAt, 'occurredAt');
  const received = iso(input.receivedAt, 'receivedAt');
  if (Date.parse(received) < Date.parse(occurred)) return { ok: false, status: 422, error: 'INVALID_EVENT_TIME' };
  const position = Number(input.position || rec.rank);
  if (!Number.isInteger(position) || position < 1) {
    return { ok: false, status: 422, error: 'INVALID_EXPOSURE_POSITION' };
  }
  db.prepare(`INSERT INTO recommendation_exposure_events
    (exposure_event_id, tenant_id, run_id, decision_id, impression_id, consultant_id,
     project_id, event_type, channel, position, propensity, occurred_at, received_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.eventId, input.tenantId, rec.run_id, rec.decision_id, rec.impression_id || null,
    input.consultantId, rec.project_id, input.eventType, input.channel,
    position, rec.propensity ?? null, occurred, received,
  );
  if (input.eventType === 'SERVED') {
    db.prepare(`UPDATE recommendation_impressions SET served_at=COALESCE(served_at,?)
      WHERE decision_id=?`).run(occurred, rec.decision_id);
  }
  return { ok: true, already: false, exposure_event_id: input.eventId };
}

const MILESTONE_STAGE = {
  QUALIFIED: '候选人', CONSENTED: '候选人', SUBMITTED: '推荐采纳',
  INTERVIEW: '面试', OFFER: 'Offer', PLACED: 'Onboard',
};

export function consumeCaseOutcome(db, { eventId, tenantId = 'brainx' }) {
  const prior = db.prepare('SELECT * FROM business_outcome_events WHERE source_event_id=? AND tenant_id=?')
    .get(eventId, tenantId);
  if (prior) return { ok: true, already: true, attributed: !!prior.attributed,
    outcome_event_id: prior.outcome_event_id };
  let written = null;
  const consumed = consumeOnce(db, eventId, 'case-outcome-v1', (tx) => {
    const event = tx.prepare('SELECT * FROM workflow_event_log WHERE event_id=?').get(eventId);
    if (!event) throw new Error('CASE_OUTCOME_EVENT_NOT_FOUND');
    if (!['case.stage_advanced', 'case.outcome_corrected'].includes(event.event_type)) {
      throw new Error('CASE_OUTCOME_EVENT_UNSUPPORTED');
    }
    const payload = parseJson(event.payload);
    const caseRow = tx.prepare('SELECT * FROM cases WHERE case_id=?').get(event.case_id);
    if (!caseRow) throw new Error('CASE_NOT_FOUND');
    const corrected = event.event_type === 'case.outcome_corrected';
    const stage = corrected ? String(payload.stage || '') : MILESTONE_STAGE[payload.to];
    if (!stage) throw new Error('CASE_OUTCOME_STAGE_UNSUPPORTED');
    const consultantId = payload.consultant_id || null;
    const decisionId = payload.decision_id || null;
    const attributed = !!(consultantId && decisionId
      && decisionReferenceIsValid(tx, consultantId, caseRow.position_id, decisionId));
    const sourceInstance = String(payload.source_instance_id || 'workflow-hub');
    const outcomeId = `boe_${sha256([tenantId, sourceInstance, eventId]).slice(0, 28)}`;
    const receivedAt = now();
    tx.prepare(`INSERT INTO business_outcome_events
      (outcome_event_id, tenant_id, source_instance_id, source_event_id, case_id,
       project_id, consultant_id, stage, event_kind, correction_of, decision_id,
       attribution_version, attributed, value_json, occurred_at, received_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      outcomeId, tenantId, sourceInstance, eventId, event.case_id, caseRow.position_id,
      consultantId, stage, corrected ? 'CORRECTED' : 'RECORDED', payload.correction_of || null,
      attributed ? decisionId : null, attributed ? 'explicit-decision-v1' : null,
      attributed ? 1 : 0, JSON.stringify(payload), event.occurred_at, receivedAt,
    );
    if (consultantId && tx.prepare('SELECT 1 FROM job_facts WHERE project_id=?').get(caseRow.position_id)) {
      tx.prepare(`INSERT INTO job_outcomes
        (project_id, consultant_id, stage, value_json, decision_id, idempotency_key,
         observed_at, kind, occurred_at, received_at, tenant_id, outcome_event_id,
         case_id, source_instance_id, source_event_id, correction_of,
         attribution_version, attributed)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        caseRow.position_id, consultantId, stage, JSON.stringify(payload), attributed ? decisionId : null,
        `case-outcome:${tenantId}:${sourceInstance}:${eventId}`, receivedAt,
        corrected ? 'CORRECTION' : 'STAGE', event.occurred_at, receivedAt, tenantId,
        outcomeId, event.case_id, sourceInstance, eventId, payload.correction_of || null,
        attributed ? 'explicit-decision-v1' : null, attributed ? 1 : 0,
      );
    }
    written = { ok: true, already: false, attributed, outcome_event_id: outcomeId };
  });
  if (consumed.skipped) {
    const row = db.prepare('SELECT * FROM business_outcome_events WHERE source_event_id=? AND tenant_id=?')
      .get(eventId, tenantId);
    return { ok: true, already: true, attributed: !!row?.attributed,
      outcome_event_id: row?.outcome_event_id || null };
  }
  return written;
}
