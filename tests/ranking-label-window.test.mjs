import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { engage } from '../src/engagement.js';
import { recordOutcome } from '../src/replay.js';
import { evaluationLabelFor, RANKING_LABEL_VERSION } from '../src/ranking-labels.js';

const SERVED = '2026-09-01T00:00:00.000Z';
const MATURE_CUTOFF = '2026-09-08T00:00:00.000Z';
const OPTIONS = { windowDays: 7, cutoffAt: MATURE_CUTOFF };
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixture() {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const run = recommend(db, 'felix', { top: 20 });
  const first = run.items[0];
  db.prepare(`UPDATE recommendation_impressions SET served_at=?
    WHERE decision_id=?`).run(SERVED, first.decision_id);
  return { db, run, first };
}

function insertOutcome(db, decisionId, projectId, {
  occurredAt, receivedAt, stage = '面试', key = 'window:outcome',
}) {
  db.prepare(`INSERT INTO job_outcomes
    (project_id, consultant_id, stage, value_json, decision_id, idempotency_key,
     observed_at, occurred_at, received_at)
    VALUES (?, 'felix', ?, '{}', ?, ?, ?, ?, ?)`)
    .run(projectId, stage, decisionId, key, receivedAt, occurredAt, receivedAt);
}

test('0052：新事件与结果保存发生/收到双时间并校验推荐归属', () => {
  const { db, first } = fixture();
  try {
    const event = engage(db, 'felix', first.job.project_id, 'VIEW', {
      decision_id: first.decision_id, idempotency_key: 'window:view',
    });
    assert.equal(event.ok, true);
    const eventRow = db.prepare(`SELECT decision_id, occurred_at, received_at
      FROM decision_events WHERE event_id=?`).get(event.event_id);
    assert.equal(eventRow.decision_id, first.decision_id);
    assert.ok(Date.parse(eventRow.received_at) >= Date.parse(eventRow.occurred_at));

    const out = recordOutcome(db, 'felix', {
      project_id: first.job.project_id, stage: '面试', decision_id: first.decision_id,
      occurred_at: '2026-09-03T00:00:00.000Z', idempotency_key: 'window:recorded',
    });
    assert.equal(out.ok, true);
    const outcome = db.prepare(`SELECT occurred_at, received_at, observed_at
      FROM job_outcomes WHERE id=?`).get(out.outcome_id);
    assert.equal(outcome.occurred_at, '2026-09-03T00:00:00.000Z');
    assert.equal(outcome.received_at, outcome.observed_at);

    const bad = recordOutcome(db, 'felix', {
      project_id: first.job.project_id, stage: 'Offer', decision_id: 'not-owned',
      idempotency_key: 'window:bad-decision',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 422);
  } finally {
    db.close();
  }
});

test('窗口内发生且截点前收到的结果形成成熟标签', () => {
  const { db, first } = fixture();
  try {
    insertOutcome(db, first.decision_id, first.job.project_id, {
      occurredAt: '2026-09-03T00:00:00.000Z', receivedAt: '2026-09-07T00:00:00.000Z',
    });
    const label = evaluationLabelFor(db, first.decision_id, OPTIONS);
    assert.equal(label.version, RANKING_LABEL_VERSION);
    assert.equal(label.status, 'MATURE');
    assert.equal(label.label, 4);
    assert.equal(label.reason, 'LABELED');
  } finally {
    db.close();
  }
});

test('未成熟、未曝光和成熟但无结果保持不同状态', () => {
  const { db, run, first } = fixture();
  try {
    const immature = evaluationLabelFor(db, first.decision_id, {
      windowDays: 7, cutoffAt: '2026-09-07T23:59:59.000Z',
    });
    assert.equal(immature.status, 'IMMATURE');
    assert.equal(immature.reason, 'WINDOW_OPEN');

    const unknown = evaluationLabelFor(db, first.decision_id, OPTIONS);
    assert.equal(unknown.status, 'MATURE');
    assert.equal(unknown.label, null);
    assert.equal(unknown.reason, 'UNKNOWN_NO_OUTCOME');

    const unexposed = evaluationLabelFor(db, run.items[1].decision_id, OPTIONS);
    assert.equal(unexposed.status, 'EXCLUDED');
    assert.equal(unexposed.reason, 'UNEXPOSED');
  } finally {
    db.close();
  }
});

test('迟到结果按收到截点进入新评估版本，窗口外结果永不进入', () => {
  const { db, first } = fixture();
  try {
    insertOutcome(db, first.decision_id, first.job.project_id, {
      occurredAt: '2026-09-03T00:00:00.000Z', receivedAt: '2026-09-10T00:00:00.000Z',
      key: 'window:late',
    });
    insertOutcome(db, first.decision_id, first.job.project_id, {
      occurredAt: '2026-09-09T00:00:00.000Z', receivedAt: '2026-09-09T01:00:00.000Z',
      stage: 'Offer', key: 'window:outside',
    });
    assert.equal(evaluationLabelFor(db, first.decision_id, OPTIONS).label, null);
    const later = evaluationLabelFor(db, first.decision_id, {
      windowDays: 7, cutoffAt: '2026-09-10T00:00:00.000Z',
    });
    assert.equal(later.label, 4);
  } finally {
    db.close();
  }
});

test('其他推荐轮次或缺双时间的事实不能污染本轮标签', () => {
  const { db, first } = fixture();
  try {
    const secondRun = recommend(db, 'felix', { top: 20 });
    const second = secondRun.items.find((item) => item.job.project_id === first.job.project_id);
    assert.ok(second);
    db.prepare(`UPDATE recommendation_impressions SET served_at=?
      WHERE decision_id=?`).run(SERVED, second.decision_id);
    insertOutcome(db, second.decision_id, second.job.project_id, {
      occurredAt: '2026-09-03T00:00:00.000Z', receivedAt: '2026-09-04T00:00:00.000Z',
      key: 'window:other-run',
    });
    assert.equal(evaluationLabelFor(db, first.decision_id, OPTIONS).label, null);
    assert.equal(evaluationLabelFor(db, second.decision_id, OPTIONS).label, 4);

    db.prepare(`INSERT INTO job_outcomes
      (project_id, consultant_id, stage, value_json, decision_id, idempotency_key, observed_at)
      VALUES (?, 'felix', 'Offer', '{}', ?, 'window:legacy', ?)`)
      .run(first.job.project_id, first.decision_id, '2026-09-04T00:00:00.000Z');
    const legacy = evaluationLabelFor(db, first.decision_id, OPTIONS);
    assert.equal(legacy.status, 'EXCLUDED');
    assert.equal(legacy.reason, 'MISSING_EVENT_TIME');
  } finally {
    db.close();
  }
});

test('窗口和数据截点必须显式且合法', () => {
  const { db, first } = fixture();
  try {
    assert.throws(() => evaluationLabelFor(db, first.decision_id, {}), /windowDays/);
    assert.throws(() => evaluationLabelFor(db, first.decision_id, {
      windowDays: 0, cutoffAt: MATURE_CUTOFF,
    }), /windowDays/);
  } finally {
    db.close();
  }
});

test('评估 CLI 缺窗口参数时在打开数据库前失败关闭', () => {
  for (const script of ['scripts/eval-ranking.mjs', 'bin/brainx-ltr-export.mjs']) {
    const run = spawnSync(process.execPath, [script, '--db', '/not-allowed/brainx.db'], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(run.status, 2, run.stderr || run.stdout);
    assert.match(run.stderr, /--cutoff-at/);
    assert.doesNotMatch(run.stderr, /SQLITE|database|ENOENT/i);
  }
});
