import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { updateProfile } from '../src/roster.js';
import { appendEvent } from '../src/hub/event-log.js';
import {
  addConsultantSignal,
  currentConsultantContext,
  recordRecommendationExposure,
  revokeConsultantSignal,
  consumeCaseOutcome,
} from '../src/profile-outcome-ledger.js';

const CID = 'felix';
const TENANT = 'brainx';

function seededDb() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  return db;
}

test('主动画像逐版追加，重复内容和个人模型切换不改画像版本', () => {
  const db = seededDb();
  const first = updateProfile(db, CID, { profile_keywords: ['AI 基础设施'], profile_note: '本周重点' });
  assert.equal(first.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consultant_profile_versions WHERE consultant_id=?').get(CID).n, 1);
  updateProfile(db, CID, { profile_keywords: ['AI 基础设施'], profile_note: '本周重点' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consultant_profile_versions WHERE consultant_id=?').get(CID).n, 1);

  db.prepare(`INSERT INTO consultant_model_profiles
    (consultant_id, feishu_account_id, agent_id, provider_id, model_id, profile_id,
     status, consent_version, consented_at, configured_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    CID, 'app:mia', 'agent:mia', 'openai', 'model-a', 'profile:mia',
    'ACTIVE', 'v1', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z',
  );
  db.prepare('UPDATE consultant_model_profiles SET model_id=?, updated_at=? WHERE consultant_id=?')
    .run('model-b', '2026-09-23T01:00:00.000Z', CID);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM consultant_profile_versions WHERE consultant_id=?').get(CID).n, 1);
  const profile = JSON.parse(db.prepare('SELECT profile_json FROM consultant_profile_versions WHERE consultant_id=?').get(CID).profile_json);
  assert.equal(profile.model_id, undefined);
});

test('短期信号可过期和撤回，当前负载从项目领域实时计算', () => {
  const db = seededDb();
  const pid = db.prepare('SELECT project_id FROM job_facts LIMIT 1').get().project_id;
  addConsultantSignal(db, {
    tenantId: TENANT, consultantId: CID, signalType: 'RECENT_DIRECTION', value: { keyword: '增长' },
    source: 'explicit-test', sampleCount: 2, confidence: 'MEDIUM', algorithmVersion: 'signal-v1',
    windowStart: '2026-09-20T00:00:00.000Z', windowEnd: '2026-09-23T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z', idempotencyKey: 'signal:active',
  });
  addConsultantSignal(db, {
    tenantId: TENANT, consultantId: CID, signalType: 'RECENT_DIRECTION', value: { keyword: '过期' },
    source: 'explicit-test', sampleCount: 1, confidence: 'LOW', algorithmVersion: 'signal-v1',
    windowStart: '2026-09-01T00:00:00.000Z', windowEnd: '2026-09-02T00:00:00.000Z',
    expiresAt: '2026-09-03T00:00:00.000Z', idempotencyKey: 'signal:expired',
  });
  db.prepare(`INSERT INTO decision_events
    (event_id,event_type,actor,occurred_at,project_id,idempotency_key,next_state)
    VALUES ('load-accepted','ACCEPTED',?,?,?,'load:accepted','ACCEPTED')`)
    .run(CID, '2026-09-23T00:00:00.000Z', pid);
  let ctx = currentConsultantContext(db, { tenantId: TENANT, consultantId: CID, at: '2026-09-24T00:00:00.000Z' });
  assert.deepEqual(ctx.signals.map((item) => item.value.keyword), ['增长']);
  assert.equal(ctx.load.accepted_projects, 1);
  revokeConsultantSignal(db, { tenantId: TENANT, consultantId: CID,
    signalId: ctx.signals[0].signal_id, reason: 'user_revoked', at: '2026-09-24T01:00:00.000Z' });
  ctx = currentConsultantContext(db, { tenantId: TENANT, consultantId: CID, at: '2026-09-24T02:00:00.000Z' });
  assert.equal(ctx.signals.length, 0);
});

test('真实曝光以事件幂等，served 与 visible 可分辨', () => {
  const db = seededDb();
  const run = recommend(db, CID, { top: 3 });
  const item = run.items[0];
  const served = recordRecommendationExposure(db, {
    tenantId: TENANT, consultantId: CID, decisionId: item.decision_id,
    eventId: 'exposure:served:1', eventType: 'SERVED', channel: 'web', position: 1,
    occurredAt: '2026-09-23T00:00:00.000Z', receivedAt: '2026-09-23T00:00:01.000Z',
  });
  assert.equal(served.ok, true);
  const duplicate = recordRecommendationExposure(db, {
    tenantId: TENANT, consultantId: CID, decisionId: item.decision_id,
    eventId: 'exposure:served:1', eventType: 'SERVED', channel: 'web', position: 1,
    occurredAt: '2026-09-23T00:00:00.000Z', receivedAt: '2026-09-23T00:00:01.000Z',
  });
  assert.equal(duplicate.already, true);
  recordRecommendationExposure(db, {
    tenantId: TENANT, consultantId: CID, decisionId: item.decision_id,
    eventId: 'exposure:visible:1', eventType: 'VISIBLE', channel: 'web', position: 1,
    occurredAt: '2026-09-23T00:00:02.000Z', receivedAt: '2026-09-23T00:00:03.000Z',
  });
  const counts = db.prepare(`SELECT event_type, COUNT(*) n FROM recommendation_exposure_events
    GROUP BY event_type ORDER BY event_type`).all();
  assert.deepEqual(counts.map((row) => ({ ...row })), [
    { event_type: 'SERVED', n: 1 },
    { event_type: 'VISIBLE', n: 1 },
  ]);
});

test('Case 结果按来源事件幂等，更正追加，无明确决策关联时不归因', () => {
  const db = seededDb();
  const run = recommend(db, CID, { top: 3 });
  const selected = run.items[0];
  db.prepare(`INSERT INTO cases
    (case_id, position_id, candidate_ref, milestone, outreach_state, version, created_at, updated_at)
    VALUES ('case-ledger',?,'candidate-ref','INTERVIEW','NOT_CONTACTED',1,?,?)`)
    .run(selected.job.project_id, '2026-09-23T00:00:00.000Z', '2026-09-23T00:00:00.000Z');
  appendEvent(db, {
    event_id: 'case-event-offer', idem_key: 'case-ledger:offer', event_type: 'case.stage_advanced',
    case_id: 'case-ledger', actor: `user:${CID}`, occurred_at: '2026-09-23T01:00:00.000Z',
    payload: { to: 'OFFER', consultant_id: CID, decision_id: selected.decision_id }, evidence_refs: [], schema_version: 1,
  });
  const first = consumeCaseOutcome(db, { eventId: 'case-event-offer', tenantId: TENANT });
  assert.equal(first.ok, true);
  assert.equal(first.attributed, true);
  assert.equal(consumeCaseOutcome(db, { eventId: 'case-event-offer', tenantId: TENANT }).already, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM business_outcome_events').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_outcomes WHERE case_id=?').get('case-ledger').n, 1);

  appendEvent(db, {
    event_id: 'case-event-correction', idem_key: 'case-ledger:correction', event_type: 'case.outcome_corrected',
    case_id: 'case-ledger', actor: `user:${CID}`, occurred_at: '2026-09-23T02:00:00.000Z',
    payload: { stage: 'INTERVIEW', consultant_id: CID, correction_of: 'case-event-offer' },
    evidence_refs: [], schema_version: 1,
  });
  const correction = consumeCaseOutcome(db, { eventId: 'case-event-correction', tenantId: TENANT });
  assert.equal(correction.attributed, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM business_outcome_events').get().n, 2);
  const row = db.prepare(`SELECT event_kind, correction_of, attributed
    FROM business_outcome_events WHERE source_event_id='case-event-correction'`).get();
  assert.deepEqual({ ...row }, {
    event_kind: 'CORRECTED', correction_of: 'case-event-offer', attributed: 0,
  });
});
