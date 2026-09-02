import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTalentMigrations } from '../src/talent-migrations.js';

function fakeConnection(applied = []) {
  const executed = [];
  return {
    executed,
    async execute(sql, params = []) {
      executed.push({ sql, params });
      if (/SELECT name, checksum FROM talent_schema_migrations/.test(sql)) {
        return [applied.map((name) => ({ name }))];
      }
      return [{ affectedRows: 1 }];
    },
  };
}

test('人才 RDS 迁移：首次按文件名执行并登记版本', async () => {
  const conn = fakeConnection();
  const out = await applyTalentMigrations(conn);
  assert.ok(out.applied.includes('0001_candidate_data_v1.mjs'));
  assert.ok(out.applied.includes('0002_job_access_grants.mjs'));
  assert.ok(conn.executed.some(({ sql }) => /CREATE TABLE IF NOT EXISTS `candidate_fact_versions`/.test(sql)));
  assert.ok(conn.executed.some(({ sql }) => /CREATE TABLE IF NOT EXISTS `talent_access_grants`/.test(sql)));
  assert.ok(conn.executed.some(({ sql }) => /CREATE TABLE IF NOT EXISTS `job_access_grants`/.test(sql)));
  assert.ok(conn.executed.some(({ sql }) => /CREATE TABLE IF NOT EXISTS `candidate_source_links`/.test(sql)));
  assert.ok(conn.executed.some(({ sql }) => /INSERT INTO talent_schema_migrations/.test(sql)));
});

test('人才 RDS 迁移：已登记文件不重复执行', async () => {
  const conn = fakeConnection(['0001_candidate_data_v1.mjs', '0002_job_access_grants.mjs']);
  const out = await applyTalentMigrations(conn);
  assert.deepEqual(out.applied, []);
  assert.equal(conn.executed.some(({ sql }) => /candidate_fact_versions/.test(sql)), false);
});
