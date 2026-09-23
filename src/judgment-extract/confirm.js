/** confirm.js — 顾问判断确认闭环：judgment_drafts → judgment_facts 转正。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 红线（同 job-extract/confirm.js）：草稿永不直写权威表，必须经本入口显式确认——
 * 血缘走专用 sync_runs 行（source='lark_judgment_extract'）；
 * 确认人可指定 project_id 关联职位（指定时须为确认人可见职位，fail-closed）。
 * V1 无 supersede 语义：权威表只追加，推翻旧判断 = 新增一条 + 人工备注。
 */
import { uuid, now } from '../db.js';
import { jobVisibleTo } from '../visibility.js';

const SELECT_DRAFT = 'SELECT * FROM judgment_drafts WHERE draft_id = ?';
const SELECT_JOB = 'SELECT 1 FROM job_facts WHERE project_id = ?';

const INSERT_SYNC = `
  INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, rows_expected, rows_read,
    complete, errors, input_hash, started_at, completed_at)
  VALUES (?, ?, 'lark_judgment_extract', ?, 1, 1, 1, '[]', ?, ?, ?)`;

const INSERT_FACT = `
  INSERT INTO judgment_facts
    (judgment_id, subject_type, subject_ref, kind, statement, evidence,
     project_id, draft_id, sync_id, confirmed_by, captured_at, raw_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_DRAFT = 'UPDATE judgment_drafts SET status=?, confirmed_at=?, confirmed_by=?, project_id=? WHERE draft_id=?';

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/**
 * 确认草稿转正。project_id 可空；指定时须为确认人可见职位（fail-closed）。
 * @returns {{ok:true, judgment_id} | {ok:false, status, error}}
 */
export function confirmJudgment(db, { draft_id, consultant_id, project_id = null }) {
  const draft = db.prepare(SELECT_DRAFT).get(draft_id);
  if (!draft) return fail(404, 'draft_not_found');
  if (draft.status !== 'pending') return fail(409, `already_${draft.status}`);
  if (!draft.kind || !draft.statement || !draft.statement_evidence) {
    return fail(400, 'insufficient_fields: 草稿缺少 kind/statement/evidence'); // 无 evidence 不进权威表
  }
  if (project_id) {
    const exists = db.prepare(SELECT_JOB).get(project_id);
    if (!exists || !jobVisibleTo(db, consultant_id, project_id)) {
      return fail(404, 'NOT_FOUND', { project_id }); // fail-closed：不区分"不存在"与"不可见"
    }
  }

  const ts = now();
  const syncId = uuid();
  const judgmentId = `jf_${uuid()}`;
  db.exec('BEGIN');
  try {
    db.prepare(INSERT_SYNC).run(syncId, consultant_id, ts, draft.draft_id, ts, ts);
    db.prepare(INSERT_FACT).run(
      judgmentId,
      draft.subject_type || 'GENERAL', draft.subject_ref || '（无明确对象）',
      draft.kind, draft.statement, draft.statement_evidence,
      project_id, draft.draft_id, syncId, consultant_id, ts, draft.raw_json,
    );
    db.prepare(UPDATE_DRAFT).run('confirmed', ts, consultant_id, project_id, draft_id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw err;
  }
  return { ok: true, judgment_id: judgmentId };
}

/** 拒绝草稿（不进 judgment_facts；rejected 终态不可再确认）。 */
export function rejectJudgment(db, { draft_id, consultant_id }) {
  const draft = db.prepare(SELECT_DRAFT).get(draft_id);
  if (!draft) return fail(404, 'draft_not_found');
  if (draft.status !== 'pending') return fail(409, `already_${draft.status}`);
  db.prepare(UPDATE_DRAFT).run('rejected', now(), consultant_id, draft.project_id, draft_id);
  return { ok: true, draft_id };
}
