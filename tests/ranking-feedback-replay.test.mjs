import assert from 'node:assert/strict';
import test from 'node:test';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { recommendationPage } from '../src/recommendation-page.js';
import { recordOpportunityIgnore } from '../src/opportunity-ignore.js';
import { feedback, undoFeedback } from '../src/recommendation-batch.js';
import { evaluationLabelFor } from '../src/ranking-labels.js';
import { NEGATIVE_REASON_CODES } from '../src/ranking-feedback.js';
import { replay } from '../src/replay.js';
import { evaluate } from '../scripts/eval-ranking.mjs';
import { exportDataset } from '../bin/brainx-ltr-export.mjs';

const CID = 'felix';
const SERVED = '2026-09-01T00:00:00.000Z';

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: CID });
  const run = recommend(db, CID, { top: 20 });
  recommendationPage(db, CID);
  const item = run.items[0];
  db.prepare('UPDATE recommendation_impressions SET served_at=? WHERE decision_id=?')
    .run(SERVED, item.decision_id);
  return { db, item };
}

function insertEvent(db, item, {
  id, type, occurredAt, receivedAt, decisionId = item.decision_id,
  reasonCode = null, reasonText = null,
}) {
  db.prepare(`INSERT INTO recommendation_feedback_events
    (event_id, consultant_id, project_id, decision_id, event_type, reason_code,
     reason_text, source, occurred_at, received_at, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'TEST', ?, ?, ?)`)
    .run(id, CID, item.job.project_id, decisionId, type, reasonCode, reasonText,
      occurredAt, receivedAt, `feedback-replay:${id}`);
}

test('0053：明确推荐忽略追加双时间事件、映射原因并保持幂等', () => {
  const { db, item } = fixture();
  try {
    const first = recordOpportunityIgnore(db, CID, item.job.project_id, 'feedback-replay:ignore', {
      decision_id: item.decision_id, reason: '不符合方向', source: 'WORKBENCH',
    });
    assert.equal(first.ok, true);
    const row = db.prepare(`SELECT * FROM recommendation_feedback_events
      WHERE idempotency_key='feedback-replay:ignore'`).get();
    assert.equal(row.decision_id, item.decision_id);
    assert.equal(row.event_type, 'NEGATIVE');
    assert.equal(row.reason_code, NEGATIVE_REASON_CODES.DIRECTION_MISMATCH);
    assert.ok(Date.parse(row.received_at) >= Date.parse(row.occurred_at));

    assert.equal(recordOpportunityIgnore(db, CID, item.job.project_id,
      'feedback-replay:ignore', { decision_id: item.decision_id }).already, true);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM recommendation_feedback_events
      WHERE idempotency_key='feedback-replay:ignore'`).get().n, 1);

    const invalid = recordOpportunityIgnore(db, CID, item.job.project_id, 'feedback-replay:bad', {
      decision_id: 'not-owned', reason: '其他', source: 'WORKBENCH',
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.status, 422);
  } finally {
    db.close();
  }
});

test('负反馈、迟到原因更正与项目级撤销按收到截点回放', () => {
  const { db, item } = fixture();
  try {
    insertEvent(db, item, {
      id: 'negative', type: 'NEGATIVE', reasonCode: 'DIRECTION_MISMATCH',
      reasonText: '方向不符', occurredAt: '2026-09-01T01:00:00.000Z',
      receivedAt: '2026-09-01T01:00:00.000Z',
    });
    insertEvent(db, item, {
      id: 'corrected', type: 'REASON_CORRECTED', reasonCode: 'JOB_QUALITY',
      reasonText: '客户质量不足', occurredAt: '2026-09-01T02:00:00.000Z',
      receivedAt: '2026-09-03T00:00:00.000Z',
    });
    insertEvent(db, item, {
      id: 'revoked', type: 'REVOKED', decisionId: null,
      occurredAt: '2026-09-01T03:00:00.000Z', receivedAt: '2026-09-04T00:00:00.000Z',
    });

    const first = evaluationLabelFor(db, item.decision_id, {
      windowDays: 1, cutoffAt: '2026-09-02T00:00:00.000Z',
    });
    assert.equal(first.label, 0);
    assert.deepEqual(first.negative_reason_codes, ['DIRECTION_MISMATCH']);
    const report = evaluate(db, { runs: 1, consultant_ids: [CID],
      windowDays: 1, cutoffAt: '2026-09-02T00:00:00.000Z' });
    assert.equal(report.negative_reason_counts.DIRECTION_MISMATCH, 1);
    const dataset = exportDataset(db, {
      windowDays: 1, cutoffAt: '2026-09-02T00:00:00.000Z',
    });
    const exported = dataset.rows.find((row) => row.decision_id === item.decision_id);
    assert.equal(exported.label, 0);
    assert.deepEqual(exported.negative_reason_codes, ['DIRECTION_MISMATCH']);

    const corrected = evaluationLabelFor(db, item.decision_id, {
      windowDays: 1, cutoffAt: '2026-09-03T00:00:00.000Z',
    });
    assert.equal(corrected.label, 0);
    assert.deepEqual(corrected.negative_reason_codes, ['JOB_QUALITY']);

    const revoked = evaluationLabelFor(db, item.decision_id, {
      windowDays: 1, cutoffAt: '2026-09-04T00:00:00.000Z',
    });
    assert.equal(revoked.label, null);
    assert.deepEqual(revoked.negative_reason_codes, []);
  } finally {
    db.close();
  }
});

test('无推荐关联的项目级忽略保留业务事实但不形成推荐标签', () => {
  const { db, item } = fixture();
  try {
    insertEvent(db, item, {
      id: 'unattributed', type: 'NEGATIVE', decisionId: null, reasonCode: 'NO_CAPACITY',
      occurredAt: '2026-09-01T01:00:00.000Z', receivedAt: '2026-09-01T01:00:00.000Z',
    });
    const label = evaluationLabelFor(db, item.decision_id, {
      windowDays: 1, cutoffAt: '2026-09-02T00:00:00.000Z',
    });
    assert.equal(label.label, null);
    assert.equal(label.reason, 'UNKNOWN_NO_OUTCOME');
  } finally {
    db.close();
  }
});

test('推荐反馈当前投影与追加事件同进退，撤销不删除历史', () => {
  const { db, item } = fixture();
  try {
    const input = { project_id: item.job.project_id, decision_id: item.decision_id,
      feedback: 'NOT_INTERESTED', reason: '不符合方向',
      idempotency_key: 'feedback-replay:web-negative' };
    assert.equal(feedback(db, CID, input).ok, true);
    assert.equal(feedback(db, CID, input).already, true);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM opportunity_ignores
      WHERE consultant_id=? AND project_id=?`).get(CID, item.job.project_id).n, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM recommendation_feedback_events
      WHERE event_type='NEGATIVE'`).get().n, 1);

    assert.equal(feedback(db, CID, { ...input, reason: '客户/职位质量不足',
      idempotency_key: 'feedback-replay:web-correction' }).updated, true);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM recommendation_feedback_events
      WHERE event_type='REASON_CORRECTED'`).get().n, 1);

    const undone = undoFeedback(db, CID, { project_id: item.job.project_id,
      decision_id: item.decision_id, idempotency_key: 'feedback-replay:web-undo' });
    assert.equal(undone.ok, true);
    assert.equal(undone.removed, true);
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM opportunity_ignores
      WHERE consultant_id=? AND project_id=?`).get(CID, item.job.project_id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recommendation_feedback').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recommendation_feedback_events').get().n, 3);
    assert.deepEqual(replay(db, item.decision_id).feedback_events.map((event) => event.event_type),
      ['NEGATIVE', 'REASON_CORRECTED', 'REVOKED']);
  } finally {
    db.close();
  }
});
