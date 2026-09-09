import { createHash } from 'node:crypto';
import { now, uuid } from '../db.js';
import { candidateShortlist } from '../candidate-shortlist.js';
import { listProjectCandidateFocus, projectSearchCandidate,
  setProjectCandidateFocus } from '../candidate-focus.js';
import { jobVisibleTo } from '../visibility.js';
import { downloadResumePdf, extractOpenmaiCandidates } from '../openmai-delivery.js';
import { sendPdfFile } from '../feishu-bot.js';
import { getAuthorizedTtcJwt } from '../ttcsdk/auth.js';
import { downloadTtcResumePdf, listTtcResumeAttachments } from '../ttcsdk/resume.js';
import { createCandidateDecisionGroup } from '../candidate-decision-group.js';

function fail(code) { throw Object.assign(new Error(code), { code }); }

function safePdfName(value, fallback) {
  const cleaned = String(value || '').replace(/[\\/\r\n\0]/g, '_').trim().slice(0, 180);
  return cleaned && /\.pdf$/i.test(cleaned) ? cleaned : fallback;
}

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

function openmaiResume(db, jobId, candidateRef) {
  const results = db.prepare(`SELECT consultant_id,result_text FROM openmai_results
    WHERE project_id=? AND status='done' ORDER BY finished_at DESC`).all(jobId);
  for (const result of results) {
    const candidate = extractOpenmaiCandidates(result.result_text)
      .find((item) => item.candidateRef === candidateRef);
    if (candidate) return { ...candidate, credentialOwner: result.consultant_id };
  }
  return null;
}

export function createCandidateActionToolHandlers({
  db, candidateShortlistFn = candidateShortlist, downloadResumeFn = downloadResumePdf,
  sendPdfFileFn = sendPdfFile, getAuthorizedTtcJwtFn = getAuthorizedTtcJwt,
  listTtcResumeAttachmentsFn = listTtcResumeAttachments,
  downloadTtcResumePdfFn = downloadTtcResumePdf,
  createCandidateDecisionGroupFn = createCandidateDecisionGroup,
} = {}) {
  return {
    brainx_candidate_workflow: async (args, context) => {
      if (args.confirm !== true || !jobVisibleTo(db, context.principal.consultantId, args.job_id)) {
        fail(args.confirm === true ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
      }
      const existing = current(db, context.principal, args);
      const discovered = projectSearchCandidate(db, args.job_id, args.candidate_ref);
      const focused = listProjectCandidateFocus(db, context.principal.tenantId, args.job_id)
        .some((candidate) => candidate.candidate_ref === args.candidate_ref);
      const permitted = existing || discovered || focused
        || await authorized(candidateShortlistFn, context.principal, args.job_id, args.candidate_ref);
      if (!permitted) {
        fail('NOT_FOUND_OR_FORBIDDEN');
      }
      if (args.action === 'KEEP_FOR_REVIEW' || args.action === 'REMOVE_FROM_REVIEW') {
        const row = setProjectCandidateFocus(db, {
          tenantId: context.principal.tenantId, consultantId: context.principal.consultantId,
          jobId: args.job_id, candidateRef: args.candidate_ref,
          sourceTaskId: discovered?.sourceTaskId || null, candidateSnapshot: discovered,
        }, args.action === 'KEEP_FOR_REVIEW');
        return { data: row, facts: [{ candidate_ref: args.candidate_ref,
          project_focus: row.focus_status === 'FOCUSED' }], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`candidate_focus:${args.job_id}:${args.candidate_ref}`],
        next_allowed_actions: row.focus_status === 'FOCUSED'
          ? ['brainx_candidate_fit', 'brainx_candidate_workflow'] : ['brainx_candidate_workflow'] };
      }
      if (args.action === 'CREATE_DECISION_GROUP') {
        const row = await createCandidateDecisionGroupFn(db, context.principal, args);
        return { data: { candidate_ref: args.candidate_ref, decision_group_status: row.status },
          facts: [{ candidate_ref: args.candidate_ref,
          decision_group_ready: row.status === 'READY' }], inferences: [], recommendations: [], unknowns: [],
          evidence_refs: [`candidate_decision_group:${row.decision_group_id}`], next_allowed_actions: [] };
      }
      const row = transition(db, context.principal, args);
      return { data: row, facts: [{ candidate_ref: args.candidate_ref, milestone: row.milestone,
        outreach_state: row.outreach_state }], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`candidate_case:${row.case_id}`], next_allowed_actions: ['brainx_candidate_contact'] };
    },
    brainx_send_candidate_resume: async (args, context) => {
      if (args.confirm !== true || context.principal.chatType !== 'group'
          || !jobVisibleTo(db, context.principal.consultantId, args.job_id)) {
        fail(args.confirm === true ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
      }
      const candidate = openmaiResume(db, args.job_id, args.candidate_ref);
      if (!candidate) fail('RESUME_NOT_AVAILABLE');
      const jwt = getAuthorizedTtcJwtFn(db, candidate.credentialOwner, 'OPENMAI');
      if (!jwt) fail('SOURCE_UNAVAILABLE');
      let bytes;
      let fileName = `${candidate.name}-简历.pdf`;
      try {
        if (candidate.resumeUrl) {
          bytes = await downloadResumeFn(candidate.resumeUrl, jwt);
        } else {
          const attachments = await listTtcResumeAttachmentsFn(candidate.candidateRef, jwt);
          const attachment = attachments.find((item) => /\.pdf(?:$|\?)/i.test(item.name || item.url))
            || attachments[0];
          if (!attachment) fail('RESUME_NOT_AVAILABLE');
          bytes = await downloadTtcResumePdfFn(attachment.url, jwt);
          fileName = safePdfName(attachment.name, fileName);
        }
        const key = createHash('sha256').update(`${args.job_id}\0${args.candidate_ref}`).digest('hex').slice(0, 32);
        await sendPdfFileFn({
          target: context.principal.chatId, data: bytes,
          fileName, idempotencyKey: `candidate-resume-${key}`,
        });
      } catch (error) {
        if (error?.code === 'RESUME_NOT_AVAILABLE' || error?.message === 'RESUME_NOT_AVAILABLE') throw error;
        fail(String(error?.message || '').startsWith('RESUME_') ? 'RESUME_NOT_AVAILABLE' : 'SOURCE_UNAVAILABLE');
      }
      return { data: { candidate_ref: args.candidate_ref, delivery_status: 'sent' },
        facts: [{ candidate_ref: args.candidate_ref, resume_sent_to_current_project_group: true }],
        inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`openmai_candidate:${args.candidate_ref}`], next_allowed_actions: [] };
    },
  };
}
