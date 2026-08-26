import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectTtcJob, profileTtcFields, TTC_FIELD_CATALOG,
  TTC_FIELD_SCHEMA_VERSION, TTC_MAIN_COLUMNS,
} from '../src/ttc-field-catalog.js';
import { toJobRow } from '../src/ttcsdk/job.js';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { latestTtcFieldReport } from '../src/ttc-field-report.js';

const raw = {
  unique_id: 'J-1', name: '平台研发负责人', company_name: '测试公司', cities: ['北京市', '上海市'],
  head_count: 2, status: 1, update_time: 1787732000000,
  pipeline_info: { pipeline_step_count: { Sourcing: 3, Interview: 1 } },
  managers: [{ name: '测试顾问' }], description: '负责平台研发',
};

test('字段库只把 TTC 真实核心字段放进默认主表', () => {
  assert.deepEqual(TTC_MAIN_COLUMNS,
    ['role', 'company', 'city', 'active_state', 'hc', 'pipeline', 'owner_name', 'captured_at']);
  assert.equal(TTC_FIELD_CATALOG.some((field) => field.key === 'industry'), false);
  assert.equal(TTC_FIELD_CATALOG.some((field) => field.key === 'score'), false);
});

test('原始职位形状检查区分阻断错误和可降级警告', () => {
  assert.deepEqual(inspectTtcJob(raw), { ok: true, errors: [], warnings: [] });
  const invalid = inspectTtcJob({ ...raw, unique_id: '', cities: '北京', status: 7 });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('|'), /unique_id/);
  assert.match(invalid.warnings.join('|'), /cities|status/);
});

test('TTC 映射保留字段版本和结构化 Pipeline，供表格真实列使用', () => {
  const row = toJobRow(raw);
  assert.equal(row.ttc.schema_version, TTC_FIELD_SCHEMA_VERSION);
  assert.deepEqual(row.ttc.pipeline_steps, { Sourcing: 3, Interview: 1 });
  assert.deepEqual(row.cities, ['北京市', '上海市']);
  assert.deepEqual(row.ttc.cities, ['北京市', '上海市']);
  assert.equal(row.pipeline, 'Sourcing×3 Interview×1');
});

test('字段覆盖不足时可展示但不开放 Excel 表头筛选', () => {
  const rows = [toJobRow(raw), toJobRow({ ...raw, unique_id: 'J-2', head_count: null, managers: [] })];
  const profile = profileTtcFields(rows);
  const byKey = Object.fromEntries(profile.fields.map((field) => [field.key, field]));
  assert.equal(byKey.company.filter_available, true);
  assert.equal(byKey.hc.display_available, true);
  assert.equal(byKey.hc.filter_available, false);
  assert.equal(byKey.owner_name.coverage, 0.5);
});

test('每次 TTC 同步都持久化可追溯的字段覆盖率报告', () => {
  const db = openDb(':memory:');
  const rows = [
    toJobRow(raw),
    toJobRow({ ...raw, unique_id: 'J-2', cities: [], head_count: null,
      pipeline_info: null, managers: [], update_time: null }),
  ];
  const sync = runSync(db, {
    source: 'ttc', consultant_id: 'mia', payload: { as_of: '2026-08-26T00:00:00Z', jobs: rows },
  });
  assert.equal(sync.field_report.sync_id, sync.sync_id);
  assert.equal(sync.field_report.schema_version, TTC_FIELD_SCHEMA_VERSION);
  assert.equal(sync.field_report.total_rows, 2);
  const report = latestTtcFieldReport(db, 'mia');
  const byKey = Object.fromEntries(report.fields.map((field) => [field.key, field]));
  assert.equal(report.rows_read, 2);
  assert.equal(byKey.company.coverage, 1);
  assert.equal(byKey.city.coverage, 0.5);
  assert.equal(byKey.pipeline.filter_available, false);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM ttc_field_reports').get().count, 1);
});
