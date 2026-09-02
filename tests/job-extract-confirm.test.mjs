/** job-extract-confirm.test.mjs — E3 确认闭环：drafts → job_facts 转正（测试先行）。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4/E3；
 * E1 只写 staging 的缺口在此闭合：草稿经显式确认才进 job_facts 权威表
 * （open_recruiter「抽取与确认分离」），血缘走专用 sync_runs 行（source='lark_extract'），
 * 新建职位同时落 job_memberships 让确认人立即可见（jobVisibleTo fail-closed）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';
import { consumeJobExtract } from '../src/job-extract/index.js';
import { confirmDraft, rejectDraft } from '../src/job-extract/confirm.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-e3-')), 't.db'));

/** 走 E1 全链路产出一条 pending 草稿，返回 {db, draft}。 */
function makeDraft(db, text, messageId) {
  registerChatContext(db, { chat_id: 'oc_g', bot_mode: 'ALL' });
  processLarkEvent(db, {
    message_id: messageId, chat_id: 'oc_g', open_id: 'ou_u',
    mentions: [], message_type: 'text',
    create_time: '2026-09-02T12:00:00+08:00', body: { text },
  });
  const row = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?')
    .get(`lark:message:${messageId}`);
  consumeJobExtract(db, row.event_id);
  const draft = db.prepare('SELECT * FROM job_facts_drafts WHERE message_id=?').get(messageId);
  assert.ok(draft, `应产出草稿: ${text}`);
  return draft;
}

test('E3: 确认草稿 → 新建 job_facts + 血缘 sync_runs + membership + 草稿转正', () => {
  const db = newDb();
  const draft = makeDraft(db, '星曜科技急招后端工程师，HC 2，base 上海', 'om_e3_1');
  const r = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, true);

  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(r.project_id);
  assert.ok(job, 'job_facts 应有新行');
  assert.equal(job.company, '星曜科技');
  assert.equal(job.role, '后端工程师');
  assert.equal(job.hc, 2);
  assert.equal(job.city, '上海');
  assert.equal(job.active_state, 'OPEN');

  const sr = db.prepare('SELECT * FROM sync_runs WHERE sync_id=?').get(job.sync_id);
  assert.ok(sr, '血缘：job_facts.sync_id 必须指向真实 sync_runs 行');
  assert.equal(sr.source, 'lark_extract');

  const mem = db.prepare('SELECT * FROM job_memberships WHERE consultant_id=? AND project_id=?')
    .get('felix', r.project_id);
  assert.ok(mem, '新建职位须同时落 membership（否则 jobVisibleTo 对确认人 fail-closed）');

  const d2 = db.prepare('SELECT * FROM job_facts_drafts WHERE draft_id=?').get(draft.draft_id);
  assert.equal(d2.status, 'confirmed');
  assert.equal(d2.confirmed_by, 'felix');
  assert.equal(d2.project_id, r.project_id);
});

test('E3: 重复确认同一草稿 → 409 already_confirmed，不产生第二条 job_facts', () => {
  const db = newDb();
  const draft = makeDraft(db, '煌炎科技急招产品经理，HC 1', 'om_e3_2');
  const r1 = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  const r2 = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'linda' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 409);
  assert.match(r2.error, /confirmed/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts').get().n, 1);
});

test('E3: 指定既有可见职位 → 走更新路径，不新建行', () => {
  const db = newDb();
  const draft = makeDraft(db, '这个岗位暂停了', 'om_e3_3'); // 只有 active_state=ON_HOLD
  // 先造一个 felix 可见的职位（membership）
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES ('sr_x', 'felix', 'fixture', ?, 'h', ?)`).run(now, now);
  db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at)
    VALUES ('pj_exist', '老公司', '老岗位', ?, 'sr_x', '{}', ?)`).run(now, now);
  db.prepare(`INSERT INTO job_memberships (consultant_id, project_id, relation, source, valid_from)
    VALUES ('felix', 'pj_exist', 'MY_JOB', 'test', ?)`).run(now);

  const r = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix', project_id: 'pj_exist' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.created, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts').get().n, 1, '不新建');
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get('pj_exist');
  assert.equal(job.active_state, 'ON_HOLD', '状态更新生效');
  assert.equal(job.company, '老公司', '草稿缺失字段不覆盖既有值');
  assert.equal(job.role, '老岗位');
});

test('E3: 指定不可见职位 → NOT_FOUND（fail-closed，不泄露存在性）', () => {
  const db = newDb();
  const draft = makeDraft(db, '星曜科技急招后端工程师', 'om_e3_4');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES ('sr_y', 'felix', 'fixture', ?, 'h', ?)`).run(now, now);
  db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at)
    VALUES ('pj_secret', '别家', '岗位', ?, 'sr_y', '{}', ?)`).run(now, now);
  // 无 membership/推荐/事件 → linda 对 pj_secret 不可见
  const r = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'linda', project_id: 'pj_secret' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(db.prepare('SELECT status FROM job_facts_drafts WHERE draft_id=?').get(draft.draft_id).status, 'pending',
    '失败的确认不得改动草稿状态');
});

test('E3: 草稿缺 company/role（信息不足）→ 400 insufficient_fields 拒绝转正', () => {
  const db = newDb();
  const draft = makeDraft(db, 'HC 2', 'om_e3_5'); // 只有 hc，无 company/role
  const r = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /company.*role|insufficient/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts').get().n, 0);
});

test('E3: 未知草稿 → 404 draft_not_found', () => {
  const db = newDb();
  const r = confirmDraft(db, { draft_id: 'no_such', consultant_id: 'felix' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.match(r.error, /draft/);
});

test('E3: 拒绝草稿 → status=rejected，不进 job_facts，且不可再确认', () => {
  const db = newDb();
  const draft = makeDraft(db, '明天团建记得带伞？不，急招数据工程师 HC 3', 'om_e3_6');
  const rj = rejectDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(rj.ok, true);
  assert.equal(db.prepare('SELECT status FROM job_facts_drafts WHERE draft_id=?').get(draft.draft_id).status, 'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM job_facts').get().n, 0);
  const rc = confirmDraft(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(rc.ok, false);
  assert.equal(rc.status, 409);
});
