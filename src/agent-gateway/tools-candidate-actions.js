import { now, uuid } from '../db.js';
import { candidateShortlist } from '../candidate-shortlist.js';
import { jobVisibleTo } from '../visibility.js';

function fail(code) { throw Object.assign(new Error(code), { code }); }

async function authorized(shortlistFn, principal, jobId, candidateRef) {
  let pageToken;
  for (let page = 0; page < 4; page += 1) {
    const bundle = await shortlistFn({ tenantId: principal.tenantId,
      consultantId: principal.consultantId, jobId, purpose: 'candidate_review',
      limit: 20, pageToken });
    if (bundle.items.some((item) => item.candidate_ref === candidateRef)) return true;
    pageToken = bundle.page.next_page_token;
    if (!pageToken) break;
  }
  return false;
}

function current(db, principal, args) {
  return db.prepare(`SELECT case_id, position_id job_ref, candidate_ref, milestone,
      outreach_state, last_note, version, created_at, updated_at
    FROM consultant_candidate_cases
    WHERE tenant_id=? AND consultant_id=? AND position_id=? AND candidate_ref=?`)
    .get(principal.tenantId, principal.consultantId, args.job_id, args.candidate_ref) || null;
}

function transition(db, principal, args) {
  const row = current(db, principal, args);
  const at = now();
  if (args.action === 'ADD_TO_PROJECT') {
    if (row) return row;
    db.prepare(`INSERT INTO consultant_candidate_cases
      (case_id,tenant_id,consultant_id,position_id,candidate_ref,last_note,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(uuid(), principal.tenantId, principal.consultantId,
      args.job_id, args.candidate_ref, args.note || null, at, at);
    return current(db, principal, args);
  }
  if (!row) fail('INVALID_ARGUMENT');
  let milestone = row.milestone;
  let outreach = row.outreach_state;
  if ((args.action === 'MARK_PREPARING' && outreach === 'PREPARING')
      || (args.action === 'RECORD_OUTREACH_SENT' && outreach === 'SENT')
      || (args.action === 'RECORD_REPLIED' && outreach === 'REPLIED')
      || (args.action === 'SUBMIT_TO_CLIENT' && milestone === 'SUBMITTED')
      || (args.action === 'MOVE_TO_INTERVIEW' && milestone === 'INTERVIEW')) return row;
  if (args.action === 'MARK_PREPARING') outreach = 'PREPARING';
  else if (args.action === 'RECORD_OUTREACH_SENT' && ['PREPARING', 'SENT'].includes(outreach)) outreach = 'SENT';
  else if (args.action === 'RECORD_REPLIED' && ['SENT', 'REPLIED'].includes(outreach)) outreach = 'REPLIED';
  else if (args.action === 'SUBMIT_TO_CLIENT' && outreach === 'REPLIED') milestone = 'SUBMITTED';
  else if (args.action === 'MOVE_TO_INTERVIEW' && milestone === 'SUBMITTED') milestone = 'INTERVIEW';
  else fail('INVALID_ARGUMENT');
  db.prepare(`UPDATE consultant_candidate_cases SET milestone=?,outreach_state=?,last_note=?,
      version=version+1,updated_at=? WHERE case_id=? AND version=?`)
    .run(milestone, outreach, args.note || row.last_note, at, row.case_id, row.version);
  return current(db, principal, args);
}

export function createCandidateActionToolHandlers({ db, candidateShortlistFn = candidateShortlist } = {}) {
  return {
    brainx_candidate_workflow: async (args, context) => {
      if (args.confirm !== true || !jobVisibleTo(db, context.principal.consultantId, args.job_id)) {
        fail(args.confirm === true ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
      }
      if (!(await authorized(candidateShortlistFn, context.principal, args.job_id, args.candidate_ref))) {
        fail('NOT_FOUND_OR_FORBIDDEN');
      }
      const row = transition(db, context.principal, args);
      return { data: row, facts: [{ candidate_ref: args.candidate_ref, milestone: row.milestone,
        outreach_state: row.outreach_state }], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`candidate_case:${row.case_id}`], next_allowed_actions: ['brainx_candidate_contact'] };
    },
  };
}
