/** confirm.js — E3 确认闭环：job_facts_drafts → job_facts 转正。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4/E3；
 * 红线：LLM/规则抽出的草稿永不直写权威表，必须经本入口显式确认——
 * 血缘走专用 sync_runs 行（source='lark_extract'，决策库"数据从哪来"可追溯）；
 * 新建职位同事务落 job_memberships（确认人立即可见，jobVisibleTo fail-closed）；
 * 更新既有职位时草稿缺失字段不覆盖既有值（COALESCE），UNKNOWN 状态不落地。
 */
import { uuid, now } from '../db.js';
import { jobVisibleTo } from '../visibility.js';

const SELECT_DRAFT = 'SELECT * FROM job_facts_drafts WHERE draft_id = ?';
const SELECT_JOB = 'SELECT 1 FROM job_facts WHERE project_id = ?';

const INSERT_SYNC = `
  INSERT INTO sync_runs (sync_id, consultant_id, source, as_of, rows_expected, rows_read,
    complete, errors, input_hash, started_at, completed_at)
  VALUES (?, ?, 'lark_extract', ?, 1, 1, 1, '[]', ?, ?, ?)`;

const INSERT_JOB = `
  INSERT INTO job_facts (project_id, company, role, city, pipeline, hc, active_state,
    captured_at, sync_id, raw_json, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_JOB = `
  UPDATE job_facts SET
    city          = COALESCE(?, city),
    pipeline      = COALESCE(?, pipeline),
    hc            = COALESCE(?, hc),
    active_state  = CASE WHEN ? = 'UNKNOWN' THEN active_state ELSE ? END,
    sync_id       = ?, raw_json = ?, updated_at = ?
  WHERE project_id = ?`;

const INSERT_MEMBERSHIP = `
  INSERT INTO job_memberships (consultant_id, project_id, relation, source, valid_from)
  VALUES (?, ?, 'MY_JOB', 'job-extract-confirm', ?)`;

const UPDATE_DRAFT = 'UPDATE job_facts_drafts SET status=?, confirmed_at=?, confirmed_by=?, project_id=? WHERE draft_id=?';

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });

/**
 * 确认草稿转正。project_id 缺省新建职位；指定时须为确认人可见职位（fail-closed）。
 * @returns {{ok:true, project_id, created:boolean} | {ok:false, status, error}}
 */
export function confirmDraft(db, { draft_id, consultant_id, project_id = null }) {
  const draft = db.prepare(SELECT_DRAFT).get(draft_id);
  if (!draft) return fail(404, 'draft_not_found');
  if (draft.status !== 'pending') return fail(409, `already_${draft.status}`);

  let created;
  let targetPid = project_id;
  if (project_id) {
    const exists = db.prepare(SELECT_JOB).get(project_id);
    if (!exists || !jobVisibleTo(db, consultant_id, project_id)) {
      return fail(404, 'NOT_FOUND', { project_id }); // fail-closed：不区分"不存在"与"不可见"
    }
    created = false;
    // 更新路径：至少一个可更新字段（company/role 由既有行保留，不要求草稿重述）
    const hasUpdatable = draft.city || draft.pipeline_stage || draft.hc != null
      || draft.active_state !== 'UNKNOWN';
    if (!hasUpdatable) return fail(400, 'insufficient_fields: 草稿无任何可更新字段');
  } else {
    // 新建职位：必须有最小可辨识字段（company+role），防止建出无名职位
    if (!draft.company || !draft.role) {
      return fail(400, 'insufficient_fields: 草稿缺少 company/role，无法新建职位');
    }
    targetPid = `pj_${uuid()}`;
    created = true;
  }

  const ts = now();
  const syncId = uuid();
  db.exec('BEGIN');
  try {
    db.prepare(INSERT_SYNC).run(syncId, consultant_id, ts, draft.draft_id, ts, ts);
    if (created) {
      db.prepare(INSERT_JOB).run(
        targetPid, draft.company, draft.role, draft.city,
        draft.pipeline_stage, draft.hc,
        draft.active_state === 'UNKNOWN' ? 'UNKNOWN' : draft.active_state,
        ts, syncId, draft.raw_json, ts,
      );
      db.prepare(INSERT_MEMBERSHIP).run(consultant_id, targetPid, ts);
    } else {
      db.prepare(UPDATE_JOB).run(
        draft.city, draft.pipeline_stage, draft.hc,
        draft.active_state, draft.active_state,
        syncId, draft.raw_json, ts, targetPid,
      );
    }
    db.prepare(UPDATE_DRAFT).run('confirmed', ts, consultant_id, targetPid, draft_id);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw err;
  }
  return { ok: true, project_id: targetPid, created };
}

/** 拒绝草稿（不进 job_facts；rejected 终态不可再确认）。 */
export function rejectDraft(db, { draft_id, consultant_id }) {
  const draft = db.prepare(SELECT_DRAFT).get(draft_id);
  if (!draft) return fail(404, 'draft_not_found');
  if (draft.status !== 'pending') return fail(409, `already_${draft.status}`);
  db.prepare(UPDATE_DRAFT).run('rejected', now(), consultant_id, draft.project_id, draft_id);
  return { ok: true, draft_id };
}
