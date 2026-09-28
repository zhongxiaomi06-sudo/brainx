/** rollup.js — 反馈环指标汇总（specs/019 US3）。
 *
 * 权威契约: specs/019-hub-event-backbone/contracts/event-types.md（四项指标口径）。
 *
 * 设计决策（research.md 决策 4 的落地修正）：不做增量计数消费者——账本事件本身就是
 * 唯一事实源，runRollup 按窗口直接从账本/曝光表重算，天然可重算、口径固定、
 * 无第二份状态可漂移。计算产物写 feedback_metrics（0053，append-only）：
 * 同窗重算追加新快照行，历史行不改写；latestMetrics 每 key+dimension 取最新。
 * 0 样本指标也落行（sample_size=0, value_num=NULL, inputs_json 说明），防静默漏数。
 */
import { uuid, now } from '../db.js';

const METRICS_VERSION = 'feedback-rollup.v1';

const INSERT_SQL = `
  INSERT INTO feedback_metrics
    (snapshot_id, window_start, window_end, metric_key, dimension,
     sample_size, value_num, inputs_json, computed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertMetric(db, w, computedAt, { key, dimension = '', sample, value, inputs }) {
  db.prepare(INSERT_SQL).run(
    uuid(), w.windowStart, w.windowEnd, key, dimension,
    sample, value,
    JSON.stringify({ version: METRICS_VERSION, ...(sample === 0 ? { note: 'zero_sample' } : {}), ...inputs }),
    computedAt,
  );
}

/** 窗口内事件计数助手 */
function countEvents(db, w, type, extraWhere = '', params = []) {
  return db.prepare(`SELECT COUNT(*) n FROM workflow_event_log
    WHERE event_type=? AND occurred_at>=? AND occurred_at<? ${extraWhere}`)
    .get(type, w.windowStart, w.windowEnd, ...params).n;
}

/** recommendation.accept_rate：窗口内 job.accepted 数 / 真实曝光数（served_at 非空）。 */
function rollupAcceptRate(db, w, computedAt) {
  const served = db.prepare(`SELECT COUNT(*) n FROM recommendation_impressions
    WHERE created_at>=? AND created_at<? AND served_at IS NOT NULL`)
    .get(w.windowStart, w.windowEnd).n;
  const accepted = countEvents(db, w, 'job.accepted');
  insertMetric(db, w, computedAt, {
    key: 'recommendation.accept_rate', sample: served,
    value: served > 0 ? accepted / served : null,
    inputs: { numerator: 'job.accepted', denominator: 'impressions.served_at_not_null', accepted },
  });
}

/** extract.field_confirm_rate：confirm/(confirm+reject)，按 domain 切片。 */
function rollupConfirmRate(db, w, computedAt) {
  const rows = db.prepare(`SELECT json_extract(payload,'$.domain') domain,
      json_extract(payload,'$.action') action, COUNT(*) n
    FROM workflow_event_log
    WHERE event_type='job_fact.reviewed' AND occurred_at>=? AND occurred_at<?
    GROUP BY 1, 2`).all(w.windowStart, w.windowEnd);
  const domains = [...new Set(rows.map((r) => r.domain).filter(Boolean))];
  for (const domain of domains) {
    const confirm = rows.find((r) => r.domain === domain && r.action === 'confirm')?.n || 0;
    const reject = rows.find((r) => r.domain === domain && r.action === 'reject')?.n || 0;
    const sample = confirm + reject;
    insertMetric(db, w, computedAt, {
      key: 'extract.field_confirm_rate', dimension: `domain=${domain}`, sample,
      value: sample > 0 ? confirm / sample : null,
      inputs: { formula: 'confirm/(confirm+reject)', confirm, reject },
    });
  }
  if (!domains.length) {
    insertMetric(db, w, computedAt, {
      key: 'extract.field_confirm_rate', dimension: '', sample: 0, value: null,
      inputs: { formula: 'confirm/(confirm+reject)' },
    });
  }
}

/** sourcing.channel_conversion：success/(success+error)，按 channel 切片。 */
function rollupChannelConversion(db, w, computedAt) {
  const rows = db.prepare(`SELECT json_extract(payload,'$.channel') channel,
      json_extract(payload,'$.status') status, COUNT(*) n
    FROM workflow_event_log
    WHERE event_type='sourcing.search_finished' AND occurred_at>=? AND occurred_at<?
    GROUP BY 1, 2`).all(w.windowStart, w.windowEnd);
  const channels = [...new Set(rows.map((r) => r.channel).filter(Boolean))];
  for (const channel of channels) {
    const success = rows.find((r) => r.channel === channel && r.status === 'success')?.n || 0;
    const error = rows.find((r) => r.channel === channel && r.status === 'error')?.n || 0;
    const sample = success + error;
    insertMetric(db, w, computedAt, {
      key: 'sourcing.channel_conversion', dimension: `channel=${channel}`, sample,
      value: sample > 0 ? success / sample : null,
      inputs: { formula: 'success/(success+error)', success, error },
    });
  }
  if (!channels.length) {
    insertMetric(db, w, computedAt, {
      key: 'sourcing.channel_conversion', dimension: '', sample: 0, value: null,
      inputs: { formula: 'success/(success+error)' },
    });
  }
}

/** job.terminal_cycle_days：job.accepted → job.terminal_recorded 的中位天数。 */
function rollupTerminalCycle(db, w, computedAt) {
  const rows = db.prepare(`SELECT json_extract(a.payload,'$.project_id') pid,
      a.occurred_at accepted_at, t.occurred_at terminal_at
    FROM workflow_event_log a
    JOIN workflow_event_log t ON t.event_type='job.terminal_recorded'
      AND json_extract(t.payload,'$.project_id') = json_extract(a.payload,'$.project_id')
    WHERE a.event_type='job.accepted'
      AND t.occurred_at >= a.occurred_at
      AND t.occurred_at >= ? AND t.occurred_at < ?
    GROUP BY pid`).all(w.windowStart, w.windowEnd);
  const days = rows
    .map((r) => (Date.parse(r.terminal_at) - Date.parse(r.accepted_at)) / 86400000)
    .filter((d) => Number.isFinite(d) && d >= 0)
    .sort((x, y) => x - y);
  const median = days.length
    ? (days.length % 2 ? days[(days.length - 1) / 2] : (days[days.length / 2 - 1] + days[days.length / 2]) / 2)
    : null;
  insertMetric(db, w, computedAt, {
    key: 'job.terminal_cycle_days', sample: days.length,
    value: median != null ? Math.round(median * 10) / 10 : null,
    inputs: { formula: 'median(terminal_at - accepted_at) days, per project first pair' },
  });
}

/**
 * 计算一个窗口的四项指标并写快照（append-only）。
 * @returns {{inserted:number, computed_at:string}}
 */
export function runRollup(db, { windowStart, windowEnd }) {
  const w = { windowStart, windowEnd };
  const computedAt = now();
  const before = db.prepare('SELECT COUNT(*) n FROM feedback_metrics').get().n;
  rollupAcceptRate(db, w, computedAt);
  rollupConfirmRate(db, w, computedAt);
  rollupChannelConversion(db, w, computedAt);
  rollupTerminalCycle(db, w, computedAt);
  const inserted = db.prepare('SELECT COUNT(*) n FROM feedback_metrics').get().n - before;
  return { inserted, computed_at: computedAt };
}

/** 每 metric_key+dimension 取最新一行（computed_at 相同毫秒时按 snapshot_id 决胜，消除并列抖动）。 */
export function latestMetrics(db, { metricKey = null, dimension = null } = {}) {
  const where = ['1=1'];
  const params = [];
  if (metricKey) { where.push('metric_key=?'); params.push(metricKey); }
  if (dimension !== null) { where.push('dimension=?'); params.push(dimension); }
  return db.prepare(`
    SELECT * FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY metric_key, dimension
        ORDER BY computed_at DESC, snapshot_id DESC
      ) rn
      FROM feedback_metrics
    ) WHERE rn = 1 AND ${where.join(' AND ')}
    ORDER BY metric_key, dimension`).all(...params)
    .map((row) => ({ ...row, inputs: JSON.parse(row.inputs_json) }));
}
