/** client-metrics.test.mjs — 客户健康指标导入与生命周期推送策略（specs/022 US6 第一批）。
 *
 * 权威契约: specs/022-client-feedback-signals/spec.md FR-2/US6 + docs/2026-09-25-first-batch-push.md。
 * 覆盖：报告解析（字段映射/分档/锚点）、import 幂等、pushPolicyFor 四档、
 * applyLifecyclePolicy（dormant 剔除 + cold_start 标注）、第一批顾问 join。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { parseReport, importReport, REPORT_SOURCE, ANCHOR_VERSION } from '../bin/brainx-client-metrics-import.mjs';
import {
  pushPolicyFor, applyLifecyclePolicy, listFirstBatchConsultants, getBenchmarks,
} from '../src/client-metrics.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-cm-')), 't.db'));

/** 最小报告 HTML：2 客户（dormant + cold_start）+ bm 锚点。 */
const SAMPLE_HTML = `<!doctype html><html><body><script>
const allClientsData = [
  {"name":"和泽科技","chat_id":"oc_a","rec_count":17,"cand_unique":7,"msg_total":180,
   "c_speed":17.2,"c_dec":0,"o_resp":0.3,"o_gap":4.77,"o_max_gap":18.04,"o_cand":28.6,"o_push":0.0,
   "final_badge":"green","stage":"dormant"},
  {"name":"示例客户","chat_id":"oc_b","rec_count":3,"cand_unique":2,"msg_total":40,
   "c_speed":5.1,"c_dec":0,"o_resp":1.2,"o_gap":1.5,"o_max_gap":3.2,"o_cand":0,"o_push":0.1,
   "final_badge":"yellow","stage":"cold_start"}
];
const bm = {"c_speed":{"p25":5.3,"p50":12.0,"p75":22.1},"o_resp":{"p25":0.8,"p50":2.2,"p75":14.3},
  "o_gap":{"p25":0.99,"p50":2.14,"p75":4.54},"o_max_gap":{"p25":4.99,"p50":9.15,"p75":18.12},
  "o_cand":{"p25":7.3,"p50":12.5,"p75":17.0},"o_push":{"p25":0.0,"p50":0.0,"p75":0.16}};
</script></body></html>`;

function seedJob(db, projectId, chatId) {
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES (?, 'felix', 'fixture', ?, 'h', ?)`).run(`sr_${projectId}`, ts, ts);
  db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at, chat_id)
    VALUES (?, '客户', '岗位', ?, ?, '{}', ?, ?)`).run(projectId, ts, `sr_${projectId}`, ts, chatId);
}

function seedConsultant(db, cid, chatIds) {
  const ts = new Date().toISOString();
  // openDb 已种子花名册（felix/mia 存在），冲突时保留既有行
  db.prepare(`INSERT INTO consultants (consultant_id, display_name, open_id, active, created_at)
    VALUES (?, ?, ?, 1, ?) ON CONFLICT(consultant_id) DO NOTHING`).run(cid, cid, `ou_${cid}`, ts);
  for (const ch of chatIds) {
    db.prepare(`INSERT INTO consultant_chats (consultant_id, chat_id, seen_at)
      VALUES (?, ?, ?)`).run(cid, ch, ts);
  }
}

test('解析：字段映射、分档、锚点齐全；含引号的字段值不截断', () => {
  const { clients, benchmarks } = parseReport(SAMPLE_HTML);
  assert.equal(clients.length, 2);
  assert.equal(clients[0].chat_id, 'oc_a');
  assert.equal(clients[0].c_feedback_hours, 17.2);
  assert.equal(clients[0].c_decision_days, 0); // c_dec 原样落库（第一批全零）
  assert.equal(clients[0].o_intent_coverage, 28.6);
  assert.equal(clients[0].stage, 'dormant');
  assert.equal(clients[1].stage, 'cold_start');
  assert.equal(benchmarks.length, 6);
  assert.deepEqual(benchmarks.find((b) => b.metric_key === 'c_feedback_hours'),
    { metric_key: 'c_feedback_hours', p25: 5.3, p50: 12.0, p75: 22.1 });
});

test('解析：缺数据块时报错而非静默', () => {
  assert.throws(() => parseReport('<html></html>'), /allClientsData/);
});

test('导入：幂等 upsert，重跑零变化；锚点按版本冻结可读', () => {
  const db = newDb();
  const parsed = parseReport(SAMPLE_HTML);
  const r1 = importReport(db, parsed);
  assert.deepEqual(r1, { clients: 2, benchmarks: 6 });
  const first = db.prepare('SELECT * FROM client_metrics ORDER BY chat_id').all();
  importReport(db, parsed); // 重跑
  const second = db.prepare('SELECT * FROM client_metrics ORDER BY chat_id').all();
  assert.equal(second.length, 2);
  assert.equal(second[0].source, REPORT_SOURCE);
  // 除 computed_at 外逐字段一致
  assert.deepEqual(second.map(({ computed_at, ...r }) => r), first.map(({ computed_at, ...r }) => r));
  const bm = getBenchmarks(db, ANCHOR_VERSION);
  assert.equal(bm.o_gap_days.p50, 2.14);
});

test('策略：dormant 静默、 cold_start 标破冰、未知 stage 不静默（宁推勿漏）', () => {
  assert.equal(pushPolicyFor('dormant').silent, true);
  assert.equal(pushPolicyFor('cold_start').tag, '破冰优先');
  assert.equal(pushPolicyFor('mature').silent, false);
  assert.equal(pushPolicyFor(undefined).silent, false);
  assert.equal(pushPolicyFor('some_new_stage').silent, false);
});

test('applyLifecyclePolicy：dormant 客户职位剔除，cold_start 注入标注，其余不动', () => {
  const db = newDb();
  importReport(db, parseReport(SAMPLE_HTML));
  seedJob(db, 'pj_dormant', 'oc_a');
  seedJob(db, 'pj_cold', 'oc_b');
  seedJob(db, 'pj_no_metric', null); // 无指标关联
  const items = [
    { job: { project_id: 'pj_dormant' }, reasons: ['r1'] },
    { job: { project_id: 'pj_cold' }, reasons: ['r2'] },
    { job: { project_id: 'pj_no_metric' }, reasons: ['r3'] },
  ];
  const { items: kept, dropped, tagged } = applyLifecyclePolicy(db, items);
  assert.equal(dropped, 1, 'dormant 剔除');
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((r) => r.job.project_id), ['pj_cold', 'pj_no_metric']);
  assert.equal(tagged.length, 1);
  assert.match(kept[0].reasons[0], /破冰优先/);
  assert.equal(kept[1].reasons[0], 'r3', '无指标职位不动');
});

test('第一批顾问：consultant_chats ⋈ client_metrics，含分档计数', () => {
  const db = newDb();
  importReport(db, parseReport(SAMPLE_HTML));
  seedConsultant(db, 'felix', ['oc_a', 'oc_b']);
  seedConsultant(db, 'mia', ['oc_unknown']); // 不在指标表 → 不进第一批
  const list = listFirstBatchConsultants(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].consultant_id, 'felix');
  assert.equal(list[0].client_count, 2);
  assert.equal(list[0].dormant_count, 1);
  assert.equal(list[0].cold_start_count, 1);
});
