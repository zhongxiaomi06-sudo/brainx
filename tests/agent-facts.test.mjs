/** agent-facts.test.mjs — job_agent_facts 存储层契约（specs/023 施工序②）。
 *
 * 覆盖：幂等 upsert（同批重跑零新增，AC-1）、群级行 NULL 主键不塌缩（红线）、
 * 可回溯三要素缺一不落库（FR-6）、按职位取最新值、结构化统计。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import {
  upsertAgentFacts, validateAgentFactRow, latestAgentFact,
  latestAgentFactsForJob, latestGroupFactsByChat, statsAgentFacts, AGENT_FACT_FIELDS,
} from '../src/agent-facts.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-af-')), 'test.db'));

const baseRow = {
  message_id: 'om_1', chat_id: 'oc_g1', project_id: 'pj_a',
  field: 'current_stage', value: '二面', confidence: 0.9,
  evidence: '约了二面', model: 'glm-4-flash-fact-agent-v1',
};

test('幂等：同批连跑两轮，第二轮零新增且 duplicates 计数正确（AC-1）', () => {
  const db = newDb();
  const r1 = upsertAgentFacts(db, [baseRow], '2026-09-24T00:00:00.000Z');
  assert.equal(r1.inserted, 1);
  assert.equal(r1.invalid.length, 0);
  const r2 = upsertAgentFacts(db, [baseRow], '2026-09-24T01:00:00.000Z');
  assert.equal(r2.inserted, 0, '第二轮必须零新增');
  assert.equal(r2.duplicates, 1);
  const n = db.prepare('SELECT COUNT(*) n FROM job_agent_facts').get().n;
  assert.equal(n, 1);
});

test('群级行（project_id NULL）主键不塌缩：同消息两群级行共存', () => {
  const db = newDb();
  const g1 = { ...baseRow, message_id: 'om_g', chat_id: 'oc_gA', project_id: null, value: 'Offer' };
  const g2 = { ...baseRow, message_id: 'om_g', chat_id: 'oc_gA', project_id: null, field: 'active_state', value: 'OPEN' };
  const r = upsertAgentFacts(db, [g1, g2], '2026-09-24T00:00:00.000Z');
  assert.equal(r.inserted, 2, 'field 不同即不同幂等键，群级行不得互相吃掉');
});

test('P0 回归：群级行重跑零新增（SQL 复合主键 NULL≠NULL，唯一性靠存储层预检）', () => {
  const db = newDb();
  const g = { ...baseRow, message_id: 'om_g', chat_id: 'oc_gA', project_id: null, value: 'OPEN', field: 'active_state' };
  const r1 = upsertAgentFacts(db, [g], '2026-09-24T00:00:00.000Z');
  assert.equal(r1.inserted, 1);
  const r2 = upsertAgentFacts(db, [g], '2026-09-24T01:00:00.000Z');
  assert.equal(r2.inserted, 0, '群级行第二轮必须零新增（AC-1 对 NULL 同样成立）');
  assert.equal(r2.duplicates, 1);
  const n = db.prepare('SELECT COUNT(*) n FROM job_agent_facts').get().n;
  assert.equal(n, 1, '总行数不得翻倍');
});

test('P0 回归：混合批次（职位级+群级）重放，两层级都零新增', () => {
  const db = newDb();
  const batch = [
    baseRow,
    { ...baseRow, message_id: 'om_g', chat_id: 'oc_gA', project_id: null, value: 'OPEN', field: 'active_state' },
  ];
  const r1 = upsertAgentFacts(db, batch, '2026-09-24T00:00:00.000Z');
  assert.equal(r1.inserted, 2);
  const r2 = upsertAgentFacts(db, batch, '2026-09-24T01:00:00.000Z');
  assert.deepEqual({ inserted: r2.inserted, duplicates: r2.duplicates }, { inserted: 0, duplicates: 2 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_agent_facts').get().n, 2);
});

test('TOCTOU 回归：绕过预检裸插重复群级行 → 部分唯一索引原子拦截（changes=0）', () => {
  const db = newDb();
  // 模拟竞态：预检通过后、写入前，他人已插同一群级行——预检无从感知，只能靠索引
  const r1 = upsertAgentFacts(db, [{
    ...baseRow, message_id: 'om_race', chat_id: 'oc_gA', project_id: null,
    value: 'OPEN', field: 'active_state',
  }], '2026-09-24T00:00:00.000Z');
  assert.equal(r1.inserted, 1);
  // 裸 INSERT OR IGNORE（不经 upsertAgentFacts 的预检）→ 索引必须让 changes=0
  const raw = db.prepare(`INSERT OR IGNORE INTO job_agent_facts
    (message_id, chat_id, project_id, field, value, confidence, evidence, model, extracted_at)
    VALUES ('om_race', 'oc_gB', NULL, 'active_state', 'OPEN', 0.9, '还在招', 'glm-x', '2026-09-24T01:00:00.000Z')`).run();
  assert.equal(raw.changes, 0, '部分唯一索引必须原子拦截群级重复（chat_id 不同也拦——幂等键不含 chat_id）');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_agent_facts').get().n, 1, '总行数不得翻倍');
});

test('P0 回归：不同群的同名群级行互不吞（message_id 相同、chat_id 不同仍应算重复——幂等键不含 chat_id）', () => {
  const db = newDb();
  const g1 = { ...baseRow, message_id: 'om_g', chat_id: 'oc_gA', project_id: null, value: 'OPEN', field: 'active_state' };
  const r1 = upsertAgentFacts(db, [g1], '2026-09-24T00:00:00.000Z');
  assert.equal(r1.inserted, 1);
  const g2 = { ...g1, chat_id: 'oc_gB' };
  const r2 = upsertAgentFacts(db, [g2], '2026-09-24T01:00:00.000Z');
  assert.equal(r2.inserted, 0, '幂等键 = message_id+field+project_id，chat_id 不参与——同一消息的抽取行唯一');
});

test('可回溯三要素（FR-6）：缺 evidence / model / message_id 一律不落库并进 invalid', () => {
  const noEvidence = validateAgentFactRow({ ...baseRow, evidence: '' });
  assert.equal(noEvidence.ok, false);
  const noModel = validateAgentFactRow({ ...baseRow, model: '' });
  assert.equal(noModel.ok, false);
  const noMsg = validateAgentFactRow({ ...baseRow, message_id: '' });
  assert.equal(noMsg.ok, false);
  const badConf = validateAgentFactRow({ ...baseRow, confidence: 1.5 });
  assert.equal(badConf.ok, false);
  const badField = validateAgentFactRow({ ...baseRow, field: 'hc' });
  assert.equal(badField.ok, false, 'MVP 只收 current_stage/active_state');
  const ok = validateAgentFactRow(baseRow);
  assert.equal(ok.ok, true);
});

test('按职位取最新有效值：多轮抽取取 extracted_at 最新一行', () => {
  const db = newDb();
  upsertAgentFacts(db, [
    { ...baseRow, value: '一面', confidence: 0.8, extractedAt: undefined }, // extracted_at 默认当前时刻
  ]);
  // 不同 message_id（同消息重抽会被幂等键吃掉——那是 AC-1 语义，不是「最新值」语义）
  upsertAgentFacts(db, [{ ...baseRow, message_id: 'om_2', value: '终面' }], '2099-01-01T00:00:00.000Z');
  const latest = latestAgentFact(db, 'pj_a', 'current_stage');
  assert.equal(latest.value, '终面');
  const all = latestAgentFactsForJob(db, 'pj_a');
  assert.deepEqual(Object.keys(all), ['current_stage']);
});

test('evidence 截断 200 字符（FR-1）', () => {
  const db = newDb();
  const long = '长'.repeat(500);
  const r = upsertAgentFacts(db, [{ ...baseRow, evidence: long }], '2026-09-24T00:00:00.000Z');
  assert.equal(r.inserted, 1);
  const len = db.prepare('SELECT LENGTH(evidence) n FROM job_agent_facts').get().n;
  assert.equal(len, 200);
});

test('群级信号只走展示通道：latestGroupFactsByChat 返回、职位查询不串', () => {
  const db = newDb();
  const group = { ...baseRow, message_id: 'om_x', project_id: null, value: 'OPEN', field: 'active_state' };
  upsertAgentFacts(db, [group], '2026-09-24T00:00:00.000Z');
  assert.equal(latestGroupFactsByChat(db, 'oc_g1').length, 1);
  assert.equal(latestAgentFact(db, 'pj_a', 'active_state'), null, '群级行绝不污染职位级读取');
});

test('statsAgentFacts：字段/层级/置信三分布齐全', () => {
  const db = newDb();
  upsertAgentFacts(db, [
    baseRow,
    { ...baseRow, message_id: 'om_2', project_id: null, field: 'active_state', value: 'OPEN', confidence: 0.5 },
  ], '2026-09-24T00:00:00.000Z');
  const s = statsAgentFacts(db);
  assert.equal(s.total, 2);
  assert.equal(s.byField.length, 2);
  assert.equal(s.byLevel.find((x) => x.level === 'group').n, 1);
  assert.equal(s.byConfidence.find((x) => x.band === 'synthesis_eligible').n, 1);
  assert.equal(s.distinctJobs, 1);
  assert.ok(AGENT_FACT_FIELDS.includes('current_stage') && AGENT_FACT_FIELDS.includes('active_state'));
});
