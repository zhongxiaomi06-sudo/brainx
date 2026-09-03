import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', 'skills');
const SKILLS = ['brainx-today', 'brainx-job', 'brainx-talent', 'brainx-match',
  'brainx-engagement-draft', 'brainx-interview-prep', 'brainx-review'];
const TOOLS = new Set(['brainx_me_context', 'brainx_daily_brief', 'brainx_job_assessment',
  'brainx_candidate_shortlist', 'brainx_candidate_facts', 'brainx_candidate_fit',
  'brainx_gap_questions', 'brainx_interview_prep', 'brainx_personal_review', 'brainx_run_status',
  'brainx_push_preferences', 'brainx_update_push_preferences', 'brainx_job_contacts',
  'brainx_candidate_contact', 'brainx_accept_job', 'brainx_start_candidate_search',
  'brainx_record_job_progress', 'brainx_candidate_workflow']);

test('七个生产 Skill 只引用 Agent Gateway 白名单工具并统一决策口径', () => {
  for (const skill of SKILLS) {
    const text = readFileSync(join(ROOT, skill, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`name: ${skill}`));
    assert.match(text, /事实/);
    assert.match(text, /推断/);
    assert.match(text, /建议/);
    assert.match(text, /未知/);
    assert.match(text, /一次只问一个|每次只问一个/);
    const mentioned = text.match(/brainx_[a-z_]+/g) || [];
    for (const tool of mentioned) assert.ok(TOOLS.has(tool), `${skill} 引用了非生产工具 ${tool}`);
  }
});

test('生产 Skill 的写操作要求确认，且不执行 SQL、Shell 或自行拼卡片 URL', () => {
  for (const skill of SKILLS) {
    const text = readFileSync(join(ROOT, skill, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(text, /query_sql|brainx_engage|brainx_sync_now|执行任意 shell/i);
    if (/brainx_(?:accept_job|record_job_progress|candidate_workflow|update_push_preferences)/.test(text)) {
      assert.match(text, /确认/);
    } else {
      assert.match(text, /不执行写操作|只读/);
    }
    assert.match(text, /不.*(?:拼接|生成).*(?:URL|链接)/i);
  }
});
