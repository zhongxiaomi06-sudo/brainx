/** TTC 字段覆盖率报告：每个 TTC 同步批次保留当时的字段质量快照。 */
import { profileTtcFields } from './ttc-field-catalog.js';

export function buildTtcFieldReport(rows, {
  sync_id, consultant_id, rows_expected, rows_read, complete, errors = [], warnings = [], created_at,
}) {
  return {
    sync_id,
    consultant_id,
    created_at,
    rows_expected,
    rows_read,
    complete,
    errors: [...errors],
    warnings: [...warnings],
    ...profileTtcFields(rows),
  };
}

export function recordTtcFieldReport(db, report) {
  db.prepare(`INSERT INTO ttc_field_reports
    (sync_id, consultant_id, schema_version, total_rows, report_json, created_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(sync_id) DO UPDATE SET
      consultant_id=excluded.consultant_id,
      schema_version=excluded.schema_version,
      total_rows=excluded.total_rows,
      report_json=excluded.report_json,
      created_at=excluded.created_at`)
    .run(report.sync_id, report.consultant_id, report.schema_version,
      report.total_rows, JSON.stringify(report), report.created_at);
  return report;
}

function parseReport(row) {
  if (!row) return null;
  try { return JSON.parse(row.report_json); } catch { return null; }
}

export function latestTtcFieldReport(db, consultant_id) {
  return parseReport(db.prepare(`SELECT report_json FROM ttc_field_reports
    WHERE consultant_id=? ORDER BY created_at DESC LIMIT 1`).get(consultant_id));
}

export function ttcFieldReportForSync(db, consultant_id, sync_id) {
  return parseReport(db.prepare(`SELECT report_json FROM ttc_field_reports
    WHERE consultant_id=? AND sync_id=?`).get(consultant_id, sync_id));
}
