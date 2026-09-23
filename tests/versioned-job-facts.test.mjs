import test from 'node:test';
import assert from 'node:assert/strict';

import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { toJobRow } from '../src/ttcsdk/job.js';
import { confirmDraft } from '../src/job-extract/confirm.js';
import { appendEvent } from '../src/hub/event-log.js';
import {
  canonicalJob,
  createSourceEnvelope,
} from '../src/job-source-contract.js';
import {
  compareJobFactProjection,
  repairJobFactProjection,
} from '../src/job-fact-store.js';
import { extractWithCache } from '../src/job-extract/cache.js';

const ISO = '2026-09-23T00:00:00.000Z';
const BASE = {
  project_id: 'job-versioned-1',
  company: '星曜科技',
  role: '后端工程师',
  city: '上海',
  cities: ['上海'],
  pipeline: 'Sourcing×1',
  hc: 2,
  active_state: 'OPEN',
  priority: null,
  notes: '负责交易系统',
  company_type: null,
  owner_name: null,
  owner_unique_id: null,
  chat_id: null,
  relation: null,
  source_url: 'fixture://job/job-versioned-1',
  captured_at: ISO,
};

function envelope(sourceInstanceId, records, overrides = {}) {
  return createSourceEnvelope({
    sourceType: sourceInstanceId.split(':')[0],
    sourceInstanceId,
    adapterVersion: 'test-v1',
    schemaVersion: 'canonical-job-v1',
    batchId: `batch:${sourceInstanceId}`,
    scope: { tenant_id: 'brainx' },
    cursor: null,
    complete: true,
    receivedAt: ISO,
    records,
    errors: [],
    ...overrides,
  });
}

test('TTC 与本地来源的同一规范事实得到等价 canonical job', () => {
  const ttc = toJobRow({
    unique_id: BASE.project_id,
    name: BASE.role,
    company_name: BASE.company,
    cities: [BASE.city],
    head_count: BASE.hc,
    analytics: BASE.notes,
    status: 1,
    update_time: Date.parse(ISO),
    pipeline_info: { pipeline_step_count: { Sourcing: 1 } },
    managers: [],
    participants: [],
    has_permission: true,
  });
  const local = { ...BASE };
  assert.deepEqual(canonicalJob(ttc), canonicalJob(local));
  assert.equal(Object.hasOwn(canonicalJob(ttc), 'ttc'), false, '下游规范事实不得携带 TTC 原字段');
});

test('来源同步追加不可变事实版本和字段证据，内容不变不增版本', () => {
  const db = openDb(':memory:');
  const first = envelope('fixture:local', [BASE]);
  runSync(db, { source: 'fixture', consultant_id: 'felix', payload: first });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_source_records').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_fact_versions').get().n, 1);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM job_field_evidence').get().n >= 6);
  const storedRaw = JSON.parse(db.prepare('SELECT raw_json FROM job_facts WHERE project_id=?')
    .get(BASE.project_id).raw_json);
  assert.equal(storedRaw.ttc, undefined);
  assert.equal(storedRaw.source_meta, undefined);

  runSync(db, { source: 'fixture', consultant_id: 'felix', payload: first });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_fact_versions').get().n, 1);

  runSync(db, { source: 'fixture', consultant_id: 'felix',
    payload: envelope('fixture:local', [{ ...BASE, hc: 3 }], { batchId: 'batch:changed' }) });
  const versions = db.prepare(`SELECT version, facts_json FROM job_fact_versions
    WHERE job_id=? ORDER BY version`).all(BASE.project_id);
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  assert.equal(JSON.parse(versions[1].facts_json).hc, 3);
});

test('不同来源字段冲突会留痕，不静默覆盖历史', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'ttc', consultant_id: 'mia',
    payload: envelope('ttc:team', [BASE]) });
  runSync(db, { source: 'adapter', consultant_id: 'mia',
    payload: envelope('local-csv:market', [{ ...BASE, city: '北京', cities: ['北京'] }]) });
  const conflicts = db.prepare(`SELECT field_path, previous_source_instance_id, incoming_source_instance_id
    FROM job_fact_conflicts WHERE job_id=? AND status='OPEN'`).all(BASE.project_id);
  assert.ok(conflicts.some((row) => row.field_path === 'city'));
  assert.ok(conflicts.some((row) => row.previous_source_instance_id === 'ttc:team'
    && row.incoming_source_instance_id === 'local-csv:market'));
});

test('不完整来源信封不关闭缺页职位，也不伪装为完整同步', () => {
  const db = openDb(':memory:');
  const second = { ...BASE, project_id: 'job-versioned-2', role: '前端工程师' };
  runSync(db, { source: 'ttc', consultant_id: 'mia',
    payload: envelope('ttc:team', [BASE, second]) });
  const out = runSync(db, { source: 'ttc', consultant_id: 'mia',
    payload: envelope('ttc:team', [{ ...BASE, hc: 4 }], {
      batchId: 'batch:partial', complete: false, cursor: 'next-page', errors: ['page_interrupted'],
    }) });
  assert.equal(out.complete, false);
  assert.equal(db.prepare('SELECT active_state FROM job_facts WHERE project_id=?').get(second.project_id).active_state, 'OPEN');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_source_records WHERE active=0').get().n, 0);
});

test('草稿确认通过同一写入口生成 MANUAL_CONFIRMED 事实版本', () => {
  const db = openDb(':memory:');
  const draftId = 'draft-versioned';
  appendEvent(db, {
    event_id: 'event-versioned', idem_key: 'versioned:draft', event_type: 'lark.message_received',
    actor: 'p2p:mia', occurred_at: ISO, payload: {}, evidence_refs: [], schema_version: 1,
  });
  db.prepare(`INSERT INTO job_facts_drafts
    (draft_id, event_id, message_id, chat_id, company, company_evidence, role, role_evidence,
     city, city_evidence, active_state, state_evidence, source, status, raw_json, extracted_at,
     origin, submitted_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`).run(
    draftId, 'event-versioned', 'message-versioned', 'ou_mia', BASE.company, BASE.company,
    BASE.role, BASE.role, BASE.city, BASE.city, 'UNKNOWN', null, 'rules', '{}', ISO, 'p2p_jd', 'mia',
  );
  const out = confirmDraft(db, { draft_id: draftId, consultant_id: 'mia' });
  assert.equal(out.ok, true);
  const version = db.prepare('SELECT origin_kind, review_status FROM job_fact_versions WHERE job_id=?')
    .get(out.project_id);
  assert.equal(version.origin_kind, 'MANUAL_CONFIRMED');
  assert.equal(version.review_status, 'CONFIRMED');
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM job_field_evidence
    WHERE fact_version=(SELECT fact_version FROM job_fact_versions WHERE job_id=?)
      AND origin_kind='MANUAL_CONFIRMED'`).get(out.project_id).n >= 3);
});

test('提炼缓存按租户和授权范围隔离，相同正文同范围不重复调用', async () => {
  const db = openDb(':memory:');
  let calls = 0;
  const extractor = async () => {
    calls++;
    return { fields: { role: { text: BASE.role, evidence: BASE.role } }, layer: 'llm', extra: null };
  };
  const input = { tenantId: 'tenant-a', scopeId: 'p2p:mia', text: '同一份职位说明',
    extractorVersion: 'job-extract-v1', modelId: 'model-a', promptVersion: 'prompt-v1', extractor };
  const first = await extractWithCache(db, input);
  const again = await extractWithCache(db, input);
  const otherScope = await extractWithCache(db, { ...input, scopeId: 'p2p:felix' });
  assert.equal(first.cached, false);
  assert.equal(again.cached, true);
  assert.equal(otherScope.cached, false);
  assert.equal(calls, 2);
});

test('投影对账默认只读，显式补偿恢复事实且不改关联引用', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix',
    payload: envelope('fixture:local', [BASE]) });
  db.prepare(`INSERT INTO job_memberships
    (consultant_id, project_id, relation, source, valid_from) VALUES ('felix',?,'MY_JOB','test',?)`)
    .run(BASE.project_id, ISO);
  const membershipId = db.prepare('SELECT id FROM job_memberships WHERE project_id=?').get(BASE.project_id).id;
  db.prepare('UPDATE job_facts SET city=? WHERE project_id=?').run('漂移城市', BASE.project_id);

  const before = compareJobFactProjection(db, { jobIds: [BASE.project_id] });
  assert.equal(before.length, 1);
  assert.ok(before[0].fields.includes('city'));
  const preview = repairJobFactProjection(db, { jobIds: [BASE.project_id] });
  assert.equal(preview.dry_run, true);
  assert.equal(db.prepare('SELECT city FROM job_facts WHERE project_id=?').get(BASE.project_id).city, '漂移城市');

  const applied = repairJobFactProjection(db, { jobIds: [BASE.project_id], dryRun: false });
  assert.equal(applied.repaired, 1);
  assert.equal(db.prepare('SELECT city FROM job_facts WHERE project_id=?').get(BASE.project_id).city, BASE.city);
  assert.equal(db.prepare('SELECT id FROM job_memberships WHERE project_id=?').get(BASE.project_id).id, membershipId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_fact_versions WHERE job_id=?').get(BASE.project_id).n, 1,
    '补偿不得伪造新历史版本');

  const missingId = 'job-versioned-missing-projection';
  runSync(db, { source: 'fixture', consultant_id: 'felix',
    payload: envelope('fixture:local', [{ ...BASE, project_id: missingId }], { batchId: 'batch:missing' }) });
  db.prepare('DELETE FROM job_facts WHERE project_id=?').run(missingId);
  const missing = compareJobFactProjection(db, { jobIds: [missingId] });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].actual, null);
  const restored = repairJobFactProjection(db, { jobIds: [missingId], dryRun: false });
  assert.equal(restored.repaired, 1);
  assert.equal(db.prepare('SELECT company FROM job_facts WHERE project_id=?').get(missingId).company, BASE.company);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_fact_versions WHERE job_id=?').get(missingId).n, 1);
});
