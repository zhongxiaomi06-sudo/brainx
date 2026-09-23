/** feedback-rollup.test.mjs — specs/019 US3：决策结果回流，指标可测量（测试先行）。
 *
 * 权威契约: specs/019-hub-event-backbone/contracts/event-types.md（四项指标口径）；
 * 判定要点：已知答案的事件集 → 快照数值与人工计算一致；0 样本落行；
 * 同窗重算 append-only（历史行不改写）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerDb, emitTestEvent } from './helpers/event-ledger.js';
import { runRollup, latestMetrics } from '../src/feedback/rollup.js';

const W = { windowStart: '2026-09-16T00:00:00.000Z', windowEnd: '2026-09-23T00:00:00.000Z' };
const at = (day, hour = 10) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;

function seedEvents(db) {
  // 外键底座：sync_runs + job_facts（recommendations 引用）
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES ('sr_seed', 'felix', 'fixture', ?, 'h', ?)`).run(at(17), at(17));
  for (const pid of ['pj_1', 'pj_2', 'pj_3', 'pj_4']) {
    db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at)
      VALUES (?, '测试公司', '测试岗位', ?, 'sr_seed', '{}', ?)`).run(pid, at(17), at(17));
  }
  // 曝光 10 次（served 8 次），接单 4 次 → accept_rate = 4/8 = 0.5
  for (let i = 0; i < 10; i += 1) {
    db.prepare(`INSERT INTO decision_runs (run_id, consultant_id, snapshot_id, policy_version,
      candidate_count, created_at) VALUES (?, 'felix', 'snap', 'v1', 10, ?)`)
      .run(`run_${i}`, at(17 + (i % 5)));
    db.prepare(`INSERT INTO recommendations (decision_id, run_id, project_id, consultant_id,
      action, score, confidence_band, evidence_coverage, reasons_json, risks_json,
      evidence_refs_json, breakdown_json, policy_version, rank, created_at)
      VALUES ('dec_${i}', 'run_${i}', 'pj_1', 'felix', 'RECOMMEND_ACCEPT', 0.9, 'HIGH', 0.9,
      '["r1","r2"]', '[]', '[]', '[]', 'v1', 1, ?)`)
      .run(at(17 + (i % 5)));
    db.prepare(`INSERT INTO recommendation_impressions
      (impression_id, run_id, decision_id, consultant_id, project_id, rank, slot_kind,
       propensity, policy_version, served_at, created_at)
      VALUES ('imp_${i}', 'run_${i}', 'dec_${i}', 'felix', 'pj_1', 1, 'NORMAL', 1, 'v1', ?, ?)`)
      .run(i < 8 ? at(17 + (i % 5), 11) : null, at(17 + (i % 5)));
  }
  for (const [i, pid] of ['pj_1', 'pj_2', 'pj_3', 'pj_4'].entries()) {
    emitTestEvent(db, { event_type: 'job.accepted', idem_key: `job.accepted:${pid}:felix`,
      actor: 'user:felix', payload: { project_id: pid, consultant_id: 'felix', source: 'daily_card' },
      occurred_at: at(18 + i) });
  }
  // 草稿确认 3 / 拒绝 1（job 域）；判断域确认 1 / 拒绝 1
  for (const [domain, action, n] of [['job', 'confirm', 3], ['job', 'reject', 1],
                                     ['judgment', 'confirm', 1], ['judgment', 'reject', 1]]) {
    for (let i = 0; i < n; i += 1) {
      emitTestEvent(db, { event_type: 'job_fact.reviewed', idem_key: `job_fact.reviewed:${domain}:d_${action}_${i}`,
        actor: 'user:felix', payload: { domain, draft_id: `d_${action}_${i}`, action, project_id: null },
        occurred_at: at(19 + i) });
    }
  }
  // 找人：openmai 2 成 1 败；supermai 1 成
  emitTestEvent(db, { event_type: 'sourcing.search_finished', idem_key: 'sourcing.finished:pj_1:om_1',
    actor: 'system:worker', payload: { project_id: 'pj_1', channel: 'openmai', round: 1, status: 'success', result_count: 6 }, occurred_at: at(20) });
  emitTestEvent(db, { event_type: 'sourcing.search_finished', idem_key: 'sourcing.finished:pj_2:om_2',
    actor: 'system:worker', payload: { project_id: 'pj_2', channel: 'openmai', round: 1, status: 'success', result_count: 3 }, occurred_at: at(20, 11) });
  emitTestEvent(db, { event_type: 'sourcing.search_finished', idem_key: 'sourcing.finished:pj_3:om_3',
    actor: 'system:worker', payload: { project_id: 'pj_3', channel: 'openmai', round: 1, status: 'error', result_count: 0 }, occurred_at: at(21) });
  emitTestEvent(db, { event_type: 'sourcing.search_finished', idem_key: 'sourcing.finished:pj_4:sm_1',
    actor: 'system:worker', payload: { project_id: 'pj_4', channel: 'supermai', round: 1, status: 'success', result_count: 5 }, occurred_at: at(21, 6) });
  // 终局：pj_1 接单(9-18) → 终局(9-22) = 4 天
  emitTestEvent(db, { event_type: 'job.terminal_recorded', idem_key: 'oc_1',
    actor: 'user:felix', payload: { project_id: 'pj_1', stage: 'ONBOARD', kind: null }, occurred_at: at(22) });
}

test('US3: 四项指标口径与人工计算一致', () => {
  const db = createLedgerDb();
  seedEvents(db);
  const out = runRollup(db, W);
  assert.ok(out.inserted >= 6, '含维度切片至少 6 行快照');

  const get = (key, dimension = '') => db.prepare(`SELECT * FROM feedback_metrics
    WHERE metric_key=? AND dimension=? AND window_start=? AND window_end=?`)
    .get(key, dimension, W.windowStart, W.windowEnd);

  const accept = get('recommendation.accept_rate');
  assert.equal(accept.sample_size, 8, '分母=窗口内真实曝光（served_at 非空）');
  assert.equal(accept.value_num, 0.5, '4 接单 / 8 曝光');

  const jobRate = get('extract.field_confirm_rate', 'domain=job');
  assert.equal(jobRate.sample_size, 4);
  assert.equal(jobRate.value_num, 0.75, '3 confirm / (3+1)');
  const jRate = get('extract.field_confirm_rate', 'domain=judgment');
  assert.equal(jRate.value_num, 0.5);

  const om = get('sourcing.channel_conversion', 'channel=openmai');
  assert.equal(om.sample_size, 3);
  assert.equal(om.value_num, 2 / 3);
  const sm = get('sourcing.channel_conversion', 'channel=supermai');
  assert.equal(sm.value_num, 1);

  const cycle = get('job.terminal_cycle_days');
  assert.equal(cycle.sample_size, 1);
  assert.equal(cycle.value_num, 4, 'pj_1 9-18 接单 → 9-22 终局 = 4 天');
});

test('US3: 0 样本指标也落行（防静默漏数）', () => {
  const db = createLedgerDb();
  runRollup(db, W);
  const rows = db.prepare('SELECT * FROM feedback_metrics').all();
  assert.ok(rows.length >= 4, '空窗口也产出全部指标行');
  for (const r of rows) assert.equal(r.sample_size, 0);
  for (const r of rows) assert.equal(r.value_num, null, '0 样本无值，inputs_json 说明');
});

test('US3: 同窗重算 append-only——历史行不改写，latestMetrics 取最新', () => {
  const db = createLedgerDb();
  seedEvents(db);
  runRollup(db, W);
  const before = db.prepare('SELECT snapshot_id, value_num FROM feedback_metrics WHERE metric_key=? AND dimension=?')
    .all('recommendation.accept_rate', '');
  runRollup(db, W); // 同窗重算
  const after = db.prepare('SELECT * FROM feedback_metrics WHERE metric_key=? AND dimension=?')
    .all('recommendation.accept_rate', '');
  assert.equal(after.length, 2, '重算追加新快照行');
  assert.ok(after.some((r) => r.snapshot_id === before[0].snapshot_id), '历史行保留');
  const latest = latestMetrics(db, { metricKey: 'recommendation.accept_rate' });
  assert.equal(latest.length, 1, 'latestMetrics 每 key+dimension 只取最新一行');
  assert.equal(latest[0].value_num, 0.5);
});
