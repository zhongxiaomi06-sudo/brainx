/** draft-cleanup.test.mjs — GLM 语义清洗纯逻辑（specs/003 延伸）。
 * 覆盖：分类回复解析容错、复活稿构造与留痕、拆稿构造、幂等键、规则缺口对账。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSplitDrafts, diffAgainstRules, parseClassifyResponse, parseJobsResponse,
  recoveryIdemKey, recoveryUpdateOf, CLASSIFY_VALUES,
} from '../src/draft-cleanup.js';

const NOW = '2026-09-23T09:00:00.000Z';

test('parseClassifyResponse：解析 JSON、容忍围栏与杂文本、拒绝非法判定', () => {
  assert.equal(parseClassifyResponse('{"verdict":"REAL_JOB","reason":"在招后端","role_hint":"AI后端开发"}').verdict, 'REAL_JOB');
  assert.equal(parseClassifyResponse('```json\n{"verdict":"NOT_JOB","reason":"寒暄"}\n```').verdict, 'NOT_JOB');
  assert.equal(parseClassifyResponse('前面废话 {"verdict":"SUSPECTED","reason":"不明"} 后缀').verdict, 'SUSPECTED');
  assert.equal(parseClassifyResponse('{"verdict":"随便说的"}'), null);
  assert.equal(parseClassifyResponse('不是 JSON'), null);
  assert.equal(parseClassifyResponse(''), null);
  const ok = parseClassifyResponse('{"verdict":"REAL_JOB","reason":"r","role_hint":"  算子工程师  "}');
  assert.equal(ok.role_hint, '算子工程师');
});

test('parseJobsResponse：要求 jobs 数组，过滤空项', () => {
  assert.deepEqual(parseJobsResponse('{"jobs":[{"company":"A","role":"R"},{"company":"B"}]}').length, 2);
  assert.equal(parseJobsResponse('{"jobs":[]}').length, 0);
  assert.equal(parseJobsResponse('{"other":1}'), null);
  assert.equal(parseJobsResponse('bad'), null);
});

test('recoveryUpdateOf：REAL_JOB 才复活、UPDATE 字段与留痕齐、NOT_JOB/无凭据拒绝', () => {
  const rejected = {
    draft_id: 'old-1', message_id: 'om-1', chat_id: 'oc-1',
    company: 'KVCache.AI', role: '', role_evidence: null,
    origin: 'group', raw_json: '{"k":"v"}',
  };
  const upd = recoveryUpdateOf(rejected, { verdict: 'REAL_JOB', reason: '在招算子', role_hint: '算子开发工程师' },
    { nowIso: NOW });
  assert.equal(upd.status, 'pending');
  assert.equal(upd.source, 'llm-recovery');
  assert.equal(upd.role, '算子开发工程师');
  const raw = JSON.parse(upd.raw_json);
  assert.equal(raw.llm_recovery_of, 'old-1');
  assert.equal(raw.k, 'v');
  assert.equal(upd.extracted_at, NOW);

  assert.equal(recoveryUpdateOf(rejected, { verdict: 'NOT_JOB' }, { nowIso: NOW }), null);
  assert.equal(recoveryUpdateOf({ ...rejected, company: '' }, { verdict: 'REAL_JOB', reason: 'r' },
    { nowIso: NOW }), null);
});

test('buildSplitDrafts：一稿拆多职位、原稿 id 留痕、无 company/role 的项被过滤', () => {
  const pending = { draft_id: 'p-1', event_id: 'ev-2', message_id: 'om-2', chat_id: 'oc-2',
    origin: 'group', raw_json: '{"j":1}' };
  const jobs = [
    { company: 'Jully.ai', role: '海外增长运营负责人', city: '北京', hc: '1' },
    { company: '', role: '' },           // 空项过滤
    { company: '长角鹿', role: '海外增长投放' },
  ];
  const out = buildSplitDrafts(pending, jobs, { nowIso: NOW, newId: (i) => `s-${i}` });
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'llm-split');
  assert.equal(out[0].status, 'pending');
  assert.equal(JSON.parse(out[0].raw_json).llm_split_of, 'p-1');
  assert.match(JSON.parse(out[0].raw_json).llm_note, /1\/2/);
  assert.equal(out[1].company, '长角鹿');
  assert.equal(buildSplitDrafts(pending, [], { nowIso: NOW, newId: () => 'x' }).length, 0);
});

test('recoveryIdemKey 与 diffAgainstRules 的四类缺口', () => {
  assert.equal(recoveryIdemKey('om-1'), 'llm-recovery:om-1');
  assert.deepEqual(diffAgainstRules({ role: '', company: 'A' }, { verdict: 'REAL_JOB', role_hint: 'x' }),
    { kind: 'role_missed_by_rules', role_hint: 'x' });
  assert.equal(diffAgainstRules({ role: 'r', company: '' }, { verdict: 'REAL_JOB' }).kind, 'company_missed_by_rules');
  assert.equal(diffAgainstRules({ role: 'r', company: 'c' }, { verdict: 'NOT_JOB' }).kind, 'rules_over_extracted');
  assert.equal(diffAgainstRules({ role: '', company: '' }, { verdict: 'SUSPECTED' }).kind, 'ambiguous');
  assert.equal(diffAgainstRules({ role: 'r', company: 'c' }, { verdict: 'REAL_JOB' }).kind, 'agree');
  assert.equal(diffAgainstRules({}, null).kind, 'no_verdict');
  assert.deepEqual(CLASSIFY_VALUES, ['REAL_JOB', 'SUSPECTED', 'NOT_JOB']);
});
