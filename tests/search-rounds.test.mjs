import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { nextSearchExclusions, normalizeExcludedCandidateRefs } from '../src/search-rounds.js';

function result(candidates) {
  return `候选人结果\n<!-- BRAINX_CANDIDATES_V1\n${JSON.stringify({ candidates })}\n-->`;
}

test('排除编号只保留安全、唯一且有界的候选引用', () => {
  assert.deepEqual(normalizeExcludedCandidateRefs([
    'TTC-1', 'TTC-1', ' bad ref ', 'TTC_2', '', null,
  ]), ['TTC-1', 'TTC_2']);
});

test('下一轮累计历史 OpenMai TTC 编号，并忽略 SuperMai 非 TTC 引用', () => {
  const db = openDb(':memory:');
  const at = new Date().toISOString();
  db.prepare(`INSERT INTO openmai_results
    (project_id,consultant_id,status,result_text,task_id,started_at,finished_at,
     excluded_candidate_refs_json)
    VALUES ('P-ROUND','felix','done',?,'om_first',?,?,?),
           ('P-ROUND','mia','done',?,'sm_second',?,?,?)`).run(
    result([{ candidate_ref: 'TTC-1', name: '甲' }]), at, at, JSON.stringify(['TTC-OLD']),
    result([
      { candidate_ref: 'EXT-1', name: '乙' },
      { candidate_ref: 'TTC-2', name: '丙', talent_url: 'https://app.ttcadvisory.com/app/talent/TTC-2' },
    ]), at, at, '[]',
  );
  assert.deepEqual(nextSearchExclusions(db, 'P-ROUND'), ['TTC-OLD', 'TTC-1', 'TTC-2']);
  db.close();
});
