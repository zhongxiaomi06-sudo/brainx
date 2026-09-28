/** alive-count.test.mjs — 轮次级「确认在招」计数（0059，2026-09-28 数据准确度修正）。
 *
 * 背景：卡片「从 N 个职位中筛选」的 N=candidate_count 含 88% UNKNOWN 状态职位（无信号源），
 * 用户侧误读为「和我相关的职位总量」。alive_count 只计 evaluated 中 active_state='OPEN'，
 * 卡片以它为主口径展示；历史行 NULL 时回退旧文案。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { runSync } from '../src/sync.js';
import { recommend, latestRun } from '../src/recommend.js';
import { buildDailyCard } from '../src/push.js';

test('recommend 落 alive_count：只计 evaluated 中 OPEN，且不超过候选池与全库 OPEN 数', () => {
  const db = openDb(':memory:');
  runSync(db, { source: 'fixture', consultant_id: 'felix' });
  const { run_id } = recommend(db, 'felix', { top: 5 });
  const run = db.prepare('SELECT candidate_count, alive_count FROM decision_runs WHERE run_id=?').get(run_id);
  assert.ok(Number.isInteger(run.alive_count), 'alive_count 应落库');
  assert.ok(run.alive_count <= run.candidate_count);
  const openTotal = db.prepare("SELECT COUNT(*) n FROM job_facts WHERE active_state='OPEN'").get().n;
  assert.ok(run.alive_count <= openTotal);
  // latestRun 透传 alive_count 给推送层
  const lr = latestRun(db, 'felix');
  assert.equal(lr.run.alive_count, run.alive_count);
});

test('卡片口径：有 alive_count 显示「确认在招」+ 评估池；历史行 NULL 回退旧文案', () => {
  const base = { consultant_name: 'T', items: [], publicBaseUrl: 'https://brainx.example.com/',
    commitments: { accepted_count: 0, need_action_count: 0 }, sync: { complete: 1 } };
  const card = buildDailyCard({ ...base, run: { run_id: 'r1', candidate_count: 23164, alive_count: 2685 } });
  assert.match(card.elements[0].content, /从 2685 个确认在招职位中筛选 · 评估池共 23164 个/);
  const legacy = buildDailyCard({ ...base, run: { run_id: 'r1', candidate_count: 23164 } });
  assert.match(legacy.elements[0].content, /从 23164 个职位中筛选/);
});
