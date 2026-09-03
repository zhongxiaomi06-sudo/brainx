import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncReloopShortlist } from '../src/reloop-shortlist-sync.js';

function sourceConnection({ boundName = 'Mia 钟笑咪' } = {}) {
  const writes = [];
  const conn = {
    writes,
    async execute(sql) {
      if (/FROM reloop_app\.users/.test(sql)) {
        return [[{ user_id: 'owner_1', display_name: '团队助手', ttc_bound_name: boundName }]];
      }
      if (/FROM reloop_app\.positions/.test(sql)) {
        return [[{ id: 31, owner_user_id: 'owner_1', position_name: 'HR岗',
          jd_analysis: { required_skills: ['招聘'] }, jd_analysis_version: 'v1',
          created_at: new Date('2026-09-01T00:00:00Z') }]];
      }
      if (/SELECT run_id, recommend_date/.test(sql)) {
        return [[{ run_id: 'source_run', recommend_date: new Date('2026-09-02T00:00:00Z') }]];
      }
      if (/JOIN reloop_app\.talent_profiles/.test(sql)) {
        return [[{ id: 1, name: '张三', company: '示例公司', position: '招聘专员',
          work_years: 3, value_score: 0.8, score: 0.7, source_rank: 1,
          skills: ['招聘'], updated_at: new Date('2026-09-02T00:00:00Z'),
          source_payload: { work: { items: [{ company_name: '示例公司', position: '招聘专员' }] } } }]];
      }
      writes.push(sql);
      return [{ affectedRows: 1 }];
    },
  };
  return conn;
}

const input = { tenantId: 'tenant_a', consultantId: 'mia', sourceOwnerId: 'owner_1',
  expectedBoundName: 'Mia 钟笑咪', positionId: 31, limit: 10 };

test('reloop 同步：默认 dry-run 只读并产出稳定职位引用', async () => {
  const conn = sourceConnection();
  const out = await syncReloopShortlist(input, { withConnection: (fn) => fn(conn) });
  assert.equal(out.dry_run, true);
  assert.equal(out.ready_candidates, 1);
  assert.equal(out.external_job_ref, 'reloop-position:31');
  assert.deepEqual(conn.writes, []);
});

test('reloop 同步：数据账号未绑定目标顾问时失败关闭', async () => {
  const conn = sourceConnection({ boundName: '其他顾问' });
  await assert.rejects(() => syncReloopShortlist(input, { withConnection: (fn) => fn(conn) }),
    /SOURCE_ACCOUNT_BINDING_MISMATCH/);
  assert.deepEqual(conn.writes, []);
});
