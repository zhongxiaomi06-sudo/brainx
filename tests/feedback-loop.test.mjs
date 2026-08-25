/** 反馈回写链路测试（2026-08-24 F1-F4 + Phase②④）。
 * F1 owner 回种 / F2 一键反馈签名与端点 / 打标导入幂等 / 诊断统计口径。 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb, now } from '../src/db.js';
import { runSync, latestCompleteSnapshot } from '../src/sync.js';
import { recommend } from '../src/recommend.js';
import { createServer } from '../src/server.js';
import { quickLink, verifyQuick } from '../src/quickfb.js';
import { makePearsonAcc, pearsonAdd, pearsonOf, buckets, weekKey, diagnose } from '../scripts/diagnose-policy.mjs';

const ROOT = join(import.meta.dirname, '..');
let db;
before(() => { db = openDb(':memory:'); });

// —— F1：owner_name 回种 job_memberships ——
// 真实 TTC 源（ttcsdk/job.js）字段齐全；缺省事实字段补 null（node:sqlite 拒绑 undefined）
const ttcPayload = (jobs) => ({ as_of: now(),
  jobs: jobs.map((j) => ({ city: null, pipeline: null, hc: null, active_state: 'OPEN', ...j })) });

test('F1: owner_name 命中花名册 → 回种 MY_JOB（source=ttc-owner）', () => {
  runSync(db, { source: 'ttc', consultant_id: 'mia', payload: ttcPayload([
    { project_id: 'JTTC001', company: '测试客户', role: '增长负责人', active_state: 'OPEN',
      owner_name: 'Mia 钟笑咪', source_url: 'ttc://job/JTTC001' },
  ]) });
  const row = db.prepare(`SELECT relation, source FROM job_memberships
    WHERE consultant_id='mia' AND project_id='JTTC001' AND valid_to IS NULL`).get();
  assert.equal(row.relation, 'MY_JOB');
  assert.equal(row.source, 'ttc-owner');
});

test('F1: 重复同步幂等（活跃 MY_JOB 仍只有一条）', () => {
  runSync(db, { source: 'ttc', consultant_id: 'mia', payload: ttcPayload([
    { project_id: 'JTTC001', company: '测试客户', role: '增长负责人', active_state: 'OPEN',
      owner_name: 'Mia 钟笑咪', source_url: 'ttc://job/JTTC001' },
  ]) });
  const n = db.prepare(`SELECT COUNT(*) n FROM job_memberships
    WHERE consultant_id='mia' AND project_id='JTTC001' AND valid_to IS NULL`).get().n;
  assert.equal(n, 1);
});

test('F1: owner 不在花名册 → 不落行；他人策展行不被冲掉', () => {
  runSync(db, { source: 'ttc', consultant_id: 'felix', payload: ttcPayload([
    { project_id: 'JTTC002', company: '客户B', role: '职位B', active_state: 'OPEN',
      owner_name: '团队外人', source_url: 'ttc://job/JTTC002' },
  ]) });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM job_memberships WHERE project_id='JTTC002'`).get().n, 0);
  // felix 策展持有 JTTC003，TTC owner=Mia：felix 的行必须保留
  // （先同步建 job_facts 再插策展行——memberships 有 project_id 外键）
  const j003 = { project_id: 'JTTC003', company: '客户C', role: '职位C',
    owner_name: 'Mia 钟笑咪', source_url: 'ttc://job/JTTC003' };
  runSync(db, { source: 'ttc', consultant_id: 'mia', payload: ttcPayload([j003]) });
  db.prepare(`INSERT INTO job_memberships (consultant_id, project_id, relation, source, valid_from)
    VALUES ('felix','JTTC003','PRIMARY_PM','curated',?)`).run(now());
  runSync(db, { source: 'ttc', consultant_id: 'mia', payload: ttcPayload([j003]) });
  const felixRow = db.prepare(`SELECT relation FROM job_memberships
    WHERE consultant_id='felix' AND project_id='JTTC003' AND valid_to IS NULL`).get();
  assert.equal(felixRow.relation, 'PRIMARY_PM');
  const miaRow = db.prepare(`SELECT relation FROM job_memberships
    WHERE consultant_id='mia' AND project_id='JTTC003' AND valid_to IS NULL`).get();
  assert.equal(miaRow.relation, 'MY_JOB');
});

// —— F2：一键反馈签名 ——
test('F2: 未配置密钥 → quickLink=null、verify=503（fail-closed）', () => {
  const saved = process.env.BRAINX_FEEDBACK_SECRET;
  delete process.env.BRAINX_FEEDBACK_SECRET;
  assert.equal(quickLink('http://x', 'mia', 'P1', 'watch', now()), null);
  assert.equal(verifyQuick({ consultant: 'mia', project: 'P1', action: 'watch', day: '2026-08-24', sig: 'x' }, now()).status, 503);
  if (saved) process.env.BRAINX_FEEDBACK_SECRET = saved;
});

test('F2: 签名往返；篡改/过期被拒', () => {
  process.env.BRAINX_FEEDBACK_SECRET = 'test-secret-64';
  const link = quickLink('http://x', 'mia', 'P1', 'watch', '2026-08-24T01:00:00Z');
  const p = Object.fromEntries(new URL(link).searchParams);
  assert.equal(verifyQuick(p, '2026-08-24T02:00:00Z').ok, true);
  assert.equal(verifyQuick(p, '2026-08-25T02:00:00Z').ok, true, '次日仍有效');
  assert.equal(verifyQuick(p, '2026-08-26T02:00:00Z').status, 403, '第三天过期');
  assert.equal(verifyQuick({ ...p, project: 'P2' }, '2026-08-24T02:00:00Z').status, 403, '篡改 project');
  assert.equal(verifyQuick({ ...p, sig: 'deadbeef' }, '2026-08-24T02:00:00Z').status, 403, '伪造签名');
});

test('F2: HTTP 端点端到端（无 session，watch 落 WATCHED 事件且幂等）', async () => {
  process.env.BRAINX_FEEDBACK_SECRET = 'test-secret-64';
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  recommend(db, 'felix', { top: 20 });
  const pid = db.prepare(`SELECT project_id FROM recommendations
    WHERE consultant_id='felix' AND rank=1 ORDER BY rowid DESC LIMIT 1`).get().project_id;
  const server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const link = quickLink(base, 'felix', pid, 'watch', now());
    const r1 = await fetch(link);
    assert.equal(r1.status, 200);
    assert.match(await r1.text(), /已记录：关注/);
    const r2 = await fetch(link); // 重复点击 → 幂等
    assert.match(await r2.text(), /此前已记录/);
    const ev = db.prepare(`SELECT event_type FROM decision_events
      WHERE actor='felix' AND project_id=? AND event_type='WATCHED'`).get(pid);
    assert.ok(ev);
    // 未签名请求被拒（B12 后按语义返回 403 签名无效，而非笼统 400）
    const r3 = await fetch(`${base}/api/v1/feedback/quick?consultant=felix&project=${pid}&action=watch&day=2026-08-24&sig=bad`);
    assert.equal(r3.status, 403);
  } finally {
    server.close();
  }
});

// —— Phase④：打标导入幂等与冲突 ——
test('打标导入：v1 标注幂等、改判记 conflict 不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brainx-label-'));
  const tdb = join(dir, 't.db');
  const csv = join(dir, 'labels.csv');
  const env = { ...process.env, BRAINX_DB: tdb };
  // 先种一个职位（走真链路）
  const seed = openDb(tdb);
  runSync(seed, { source: 'ttc', consultant_id: 'mia', payload: ttcPayload([
    { project_id: 'JLBL001', company: '客户L', role: '职位L', active_state: 'OPEN', source_url: 'ttc://job/JLBL001' },
  ]) });
  seed.close();
  writeFileSync(csv, 'consultant,project_id,label,reason\nmia,JLBL001,会接,其他\n');
  const run = () => execFileSync('node', [join(ROOT, 'bin', 'brainx-label-import.mjs'), '--file', csv],
    { env, encoding: 'utf8' });
  const r1 = JSON.parse(run());
  assert.equal(r1.inserted, 1);
  const r2 = JSON.parse(run());
  assert.equal(r2.already, 1, '重复导入跳过');
  writeFileSync(csv, 'consultant,project_id,label,reason\nmia,JLBL001,没兴趣,不符合方向\n');
  let conflict = null;
  try { execFileSync('node', [join(ROOT, 'bin', 'brainx-label-import.mjs'), '--file', csv], { env, encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { conflict = JSON.parse(e.stdout); }
  assert.equal(conflict.conflicts.length, 1, '改判记 conflict');
  const check = openDb(tdb);
  const v = JSON.parse(check.prepare(`SELECT value_json FROM job_outcomes
    WHERE project_id='JLBL001' AND stage='人工标注'`).get().value_json);
  assert.equal(v.label, '会接', '原标注不被覆盖');
  assert.equal(v.scheme, 'v1');
  check.close();
});

// —— Phase②：诊断统计口径 ——
test('诊断：Pearson / 分桶 / 周键 纯函数', () => {
  const acc = makePearsonAcc();
  [[1, 2], [2, 4], [3, 6], [4, 8]].forEach(([x, y]) => pearsonAdd(acc, x, y));
  assert.equal(pearsonOf(acc), 1, '完全线性 → r=1');
  assert.deepEqual(buckets([10, 55, 60, 95], [55, 90]), [1, 2, 1]);
  assert.equal(weekKey('2026-08-24'), '2026-08-24', '2026-08-24 是周一');
  assert.equal(weekKey('2026-08-26'), '2026-08-24');
});

test('诊断：diagnose() 在内存链路上产出结构与 verdict', () => {
  const d = openDb(':memory:');
  runSync(d, { source: 'fixture', consultant_id: 'felix' });
  recommend(d, 'felix', { top: 20 });
  const report = diagnose(d);
  assert.ok(report.rows_scanned > 0);
  assert.ok('direction|similarity' in report.correlation);
  assert.ok(report.score_distribution.top20.n > 0);
  assert.ok(Array.isArray(report.exploration.weekly_top20_rotation));
  assert.ok(report.verdicts.some((v) => v.id === 'OUTCOMES_STARVED'), '内存库无 outcomes → 必触发');
  d.close();
});

after(() => { db.close(); });
