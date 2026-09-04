/** data-quality.test.mjs — P2 主线数据质量安全闸回归。
 *
 * 锁定「脏数据不得产出推荐」的核心纪律（2026-09-04 修订）：
 *  ① 无任何完整快照 → recommend blocked（不落推荐）
 *  ② 行级脏数据（缺 project_id / 缺客户或职位名）只跳过该行并记 warnings，
 *     不判废整轮 complete——个别脏行不得冻结全员推荐（2026-09-04 事故回归）
 *  ③ 最近一次同步 complete=0（批级故障：限流/分页中断）→ recommend 仍 blocked
 *  ④ 同输入重复同步 → input_hash 一致（可判定「无变化」，支撑增量/幂等）
 *  ⑤ 重复同步不新增 job_facts（project_id 唯一 UPSERT）
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend } from '../src/recommend.js';

const CID = 'felix';
let db;
beforeEach(() => { db = openDb(':memory:'); });

test('安全闸：无完整快照时 recommend 被 blocked、不落推荐', () => {
  const r = recommend(db, CID, { dry_run: true });
  assert.equal(r.blocked, true, '没同步过应 blocked');
  assert.equal(r.items.length, 0);
  assert.equal(r.run_id, null);
});

test('安全闸：行级脏数据只跳过不判废整轮，脏行不入库（2026-09-04 解冻回归）', () => {
  // 缺 company/role 的脏行 → 记 warnings 并跳过，complete 保持 1
  const dirty = [{ project_id: 'P-DIRTY', company: '', role: '', active_state: 'OPEN' }];
  const out = runSync(db, { source: 'bridge', consultant_id: CID, payload: { as_of: '2026-08-18', jobs: dirty } });
  assert.equal(out.complete, true, '行级脏数据不得判废整轮 complete');
  assert.equal(out.errors.length, 0, '行级校验失败不得进 errors');
  assert.ok(out.warnings.some((w) => w.includes('P-DIRTY') && w.includes('缺客户或职位名')), '脏行应有行级 warning');
  const n = db.prepare('SELECT COUNT(*) n FROM job_facts').get().n;
  assert.equal(n, 0, '脏行不得入库');
  const r = recommend(db, CID, { dry_run: true });
  assert.equal(r.blocked ?? false, false, '纯脏行输入不得冻结推荐链路');
  assert.equal(r.items.length, 0);
});

test('安全闸：混入脏行时有效职位仍入库（行级降级不丢好数据）', () => {
  const jobs = [
    { project_id: 'P-OK', company: 'Acme', role: '后端工程师', city: '上海',
      pipeline: 'SCREENING', hc: 1, active_state: 'OPEN', priority: 'HIGH',
      source_url: 'https://example.com/p-ok', captured_at: '2026-08-18' },
    { project_id: 'P-DIRTY', company: '', role: '', active_state: 'OPEN' },
  ];
  const out = runSync(db, { source: 'bridge', consultant_id: CID, payload: { as_of: '2026-08-18', jobs } });
  assert.equal(out.complete, true, '混入脏行仍应完整');
  assert.equal(out.rows_read, 1, '只读有效行');
  const ids = db.prepare(`SELECT project_id FROM job_facts WHERE project_id IN ('P-OK','P-DIRTY')`)
    .all().map((r) => r.project_id);
  assert.deepEqual(ids.sort(), ['P-OK'], '有效行入库、脏行被跳过');
});

test('安全闸：最近一次同步 complete=0（批级故障）时 recommend 仍 blocked', () => {
  // complete=0 现在只来自批级故障（限流/分页中断等），行级脏数据不再产生它。
  db.prepare(`INSERT INTO sync_runs
    (sync_id, consultant_id, source, as_of, rows_expected, rows_read, complete, errors, input_hash, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run('sync-broken', CID, 'ttc', '2026-08-18', 10, 0, 0,
         JSON.stringify(['限流中断']), 'hash-broken', '2026-08-18T00:00:00', '2026-08-18T00:00:01');
  const r = recommend(db, CID, { dry_run: true });
  assert.equal(r.blocked, true, '批级不完整同步应 fail-closed');
});

test('幂等：同输入重复同步 → input_hash 一致', () => {
  const a = runSync(db, { source: 'fixture', consultant_id: CID });
  const b = runSync(db, { source: 'fixture', consultant_id: CID });
  assert.equal(a.input_hash, b.input_hash, '同一 fixture 两次同步 input_hash 应一致');
  assert.ok(a.complete && b.complete);
});

test('去重：重复同步不新增 job_facts（project_id 唯一 UPSERT）', () => {
  runSync(db, { source: 'fixture', consultant_id: CID });
  const n1 = db.prepare('SELECT COUNT(*) n FROM job_facts').get().n;
  runSync(db, { source: 'fixture', consultant_id: CID });
  const n2 = db.prepare('SELECT COUNT(*) n FROM job_facts').get().n;
  assert.equal(n1, n2, '重复同步职位数不变');
  assert.ok(n1 > 0);
});

test('完整同步后 recommend 能产出（安全闸放行）', () => {
  runSync(db, { source: 'fixture', consultant_id: CID });
  const r = recommend(db, CID, { dry_run: true });
  assert.equal(r.blocked ?? false, false, '完整快照后应放行');
  assert.ok(Array.isArray(r.items));
});
