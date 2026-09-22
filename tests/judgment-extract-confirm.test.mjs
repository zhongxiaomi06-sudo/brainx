/** judgment-extract-confirm.test.mjs — 判断确认闭环：drafts → judgment_facts 转正（specs/016）。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 红线同 job-extract：草稿永不直写权威表，显式确认才进 judgment_facts，
 * 血缘走 sync_runs(source='lark_judgment_extract')；关联职位 fail-closed。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { registerChatContext } from '../src/gateway/chat-contexts.js';
import { processLarkEvent } from '../src/gateway/lark-gateway.js';
import { consumeJudgmentExtract } from '../src/judgment-extract/index.js';
import { confirmJudgment, rejectJudgment } from '../src/judgment-extract/confirm.js';

const newDb = () => openDb(join(mkdtempSync(join(tmpdir(), 'brainx-j3-')), 't.db'));

/** 走全链路产出一条 pending 判断草稿。 */
function makeDraft(db, text, messageId) {
  registerChatContext(db, { chat_id: 'oc_g', bot_mode: 'ALL' });
  processLarkEvent(db, {
    message_id: messageId, chat_id: 'oc_g', open_id: 'ou_u',
    mentions: [], message_type: 'text',
    create_time: '2026-09-22T12:00:00+08:00', body: { text },
  });
  const row = db.prepare('SELECT event_id FROM workflow_event_log WHERE idem_key=?')
    .get(`lark:message:${messageId}`);
  consumeJudgmentExtract(db, row.event_id);
  const draft = db.prepare('SELECT * FROM judgment_drafts WHERE message_id=?').get(messageId);
  assert.ok(draft, `应产出草稿: ${text}`);
  return draft;
}

function seedJob(db, projectId, consultantId = 'felix') {
  const now = new Date().toISOString();
  const owner = consultantId || 'someone_else'; // sync_runs.consultant_id NOT NULL
  db.prepare(`INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, input_hash, started_at)
    VALUES (?, ?, 'fixture', ?, 'h', ?)`).run(`sr_${projectId}`, owner, now, now);
  db.prepare(`INSERT INTO job_facts (project_id, company, role, captured_at, sync_id, raw_json, updated_at)
    VALUES (?, '老公司', '老岗位', ?, ?, '{}', ?)`).run(projectId, now, `sr_${projectId}`, now);
  if (consultantId) {
    db.prepare(`INSERT INTO job_memberships (consultant_id, project_id, relation, source, valid_from)
      VALUES (?, ?, 'MY_JOB', 'test', ?)`).run(consultantId, projectId, now);
  }
}

test('确认草稿 → 新建 judgment_facts + 血缘 sync_runs + 草稿转正', () => {
  const db = newDb();
  const draft = makeDraft(db, '星曜科技说：不接受异地候选人', 'om_jc_1');
  const r = confirmJudgment(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(r.ok, true, JSON.stringify(r));

  const fact = db.prepare('SELECT * FROM judgment_facts WHERE judgment_id=?').get(r.judgment_id);
  assert.ok(fact, 'judgment_facts 应有新行');
  assert.equal(fact.subject_type, 'CLIENT_COMPANY');
  assert.equal(fact.subject_ref, '星曜科技');
  assert.equal(fact.kind, 'CONSTRAINT');
  assert.ok(fact.statement.includes('不接受异地'));
  assert.ok(fact.evidence.length > 0);
  assert.equal(fact.draft_id, draft.draft_id, '血缘：指向来源草稿');
  assert.equal(fact.confirmed_by, 'felix');
  assert.equal(fact.project_id, null, '未指定时职位关联为空');

  const sr = db.prepare('SELECT * FROM sync_runs WHERE sync_id=?').get(fact.sync_id);
  assert.ok(sr, '血缘：sync_id 必须指向真实 sync_runs 行');
  assert.equal(sr.source, 'lark_judgment_extract');

  const d2 = db.prepare('SELECT * FROM judgment_drafts WHERE draft_id=?').get(draft.draft_id);
  assert.equal(d2.status, 'confirmed');
  assert.equal(d2.confirmed_by, 'felix');
});

test('重复确认同一草稿 → 409 already_confirmed，不产生第二条 judgment_facts', () => {
  const db = newDb();
  const draft = makeDraft(db, '煌炎科技要求：只要硕士学历', 'om_jc_2');
  const r1 = confirmJudgment(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  const r2 = confirmJudgment(db, { draft_id: draft.draft_id, consultant_id: 'linda' });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 409);
  assert.match(r2.error, /confirmed/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_facts').get().n, 1);
});

test('指定可见职位 → project_id 落权威行；不可见职位 → 404 fail-closed', () => {
  const db = newDb();
  seedJob(db, 'pj_visible', 'felix');
  seedJob(db, 'pj_secret', null); // 无任何可见性授予
  const d1 = makeDraft(db, '星曜科技说：不接受异地候选人', 'om_jc_3');
  const ok = confirmJudgment(db, { draft_id: d1.draft_id, consultant_id: 'felix', project_id: 'pj_visible' });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(db.prepare('SELECT project_id FROM judgment_facts WHERE judgment_id=?')
    .get(ok.judgment_id).project_id, 'pj_visible');

  const d2 = makeDraft(db, '星曜科技说：不看外包背景', 'om_jc_4');
  const no = confirmJudgment(db, { draft_id: d2.draft_id, consultant_id: 'linda', project_id: 'pj_secret' });
  assert.equal(no.ok, false);
  assert.equal(no.status, 404);
  assert.equal(db.prepare('SELECT status FROM judgment_drafts WHERE draft_id=?').get(d2.draft_id).status,
    'pending', '失败的确认不得改动草稿状态');
});

test('未知草稿 → 404 draft_not_found', () => {
  const db = newDb();
  const r = confirmJudgment(db, { draft_id: 'no_such', consultant_id: 'felix' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('拒绝草稿 → status=rejected，不进 judgment_facts，且不可再确认', () => {
  const db = newDb();
  const draft = makeDraft(db, '星曜科技说：不接受异地候选人', 'om_jc_5');
  const rj = rejectJudgment(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(rj.ok, true);
  assert.equal(db.prepare('SELECT status FROM judgment_drafts WHERE draft_id=?').get(draft.draft_id).status,
    'rejected');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM judgment_facts').get().n, 0);
  const rc = confirmJudgment(db, { draft_id: draft.draft_id, consultant_id: 'felix' });
  assert.equal(rc.ok, false);
  assert.equal(rc.status, 409);
});
