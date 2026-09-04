import { acceptCommitment, recordProgress } from '../commitment.js';
import { currentState } from '../engagement.js';
import { jobVisibleTo } from '../visibility.js';
import { startOpenmaiTask } from '../openmai-task.js';
import { getPushPreferences, updatePushPreferences } from '../push-preferences.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function requireVisible(db, principal, jobId) {
  const job = db.prepare('SELECT * FROM job_facts WHERE project_id=?').get(jobId);
  if (!job || !jobVisibleTo(db, principal.consultantId, jobId)) fail('NOT_FOUND_OR_FORBIDDEN');
  return job;
}

function requireConfirmation(args) {
  if (args.confirm !== true) fail('INVALID_ARGUMENT');
}

function safeAction(action) {
  if (!action) return null;
  return { action_ref: action.action_id, title: action.title, due_at: action.due_at,
    status: action.status, source: action.source, updated_at: action.updated_at };
}

function acceptJob(db, args, principal, startSearch) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  const result = acceptCommitment(db, principal.consultantId, args.job_id, {
    goal: args.goal,
    action_title: args.action_title,
    due_at: args.due_at,
    idempotency_key: args.idempotency_key,
  });
  if (!result.ok) fail(result.status === 404 ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
  let search = null;
  if (!result.already || result.state === 'ACCEPTED') {
    search = startSearch(db, principal.consultantId, args.job_id);
  }
  return {
    data: { job_ref: args.job_id, state: result.state, active_action: safeAction(result.active_action), search },
    facts: [{ job_ref: args.job_id, state: result.state }],
    inferences: [], recommendations: [], unknowns: [],
    evidence_refs: [`engagement:${args.job_id}`, `action:${result.active_action?.action_id || 'none'}`],
    next_allowed_actions: ['brainx_run_status', 'brainx_record_job_progress'],
  };
}

function startSearchForJob(db, args, principal, startSearch) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  if (currentState(db, principal.consultantId, args.job_id).state !== 'ACCEPTED') fail('JOB_NOT_ACCEPTED');
  const search = startSearch(db, principal.consultantId, args.job_id, { force: args.force === true });
  return {
    data: { job_ref: args.job_id, search }, facts: [{ job_ref: args.job_id, search_status: search.status }],
    inferences: [], recommendations: [], unknowns: search.message ? [search.message] : [],
    evidence_refs: [`openmai:${args.job_id}`], next_allowed_actions: ['brainx_run_status'],
  };
}

function recordJobProgress(db, args, principal) {
  requireConfirmation(args);
  requireVisible(db, principal, args.job_id);
  const result = recordProgress(db, principal.consultantId, args.job_id, {
    action_id: args.action_id,
    kind: args.kind,
    stage: args.stage,
    summary: args.summary,
    next_action: { title: args.next_action_title, due_at: args.next_due_at },
    idempotency_key: args.idempotency_key,
  });
  if (!result.ok) fail(result.status === 404 ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
  return {
    data: { job_ref: args.job_id, active_action: safeAction(result.active_action) },
    facts: [{ job_ref: args.job_id, progress_recorded: true, stage: args.stage || null }],
    inferences: [], recommendations: [], unknowns: [],
    evidence_refs: [`engagement:${args.job_id}`, `action:${result.active_action?.action_id || 'none'}`],
    next_allowed_actions: ['brainx_job_assessment'],
  };
}

export function createActionToolHandlers({ db, startSearchFn } = {}) {
  const startSearch = startSearchFn || ((store, consultantId, jobId, options) => (
    startOpenmaiTask(store, null, consultantId, jobId, options)
  ));
  return {
    brainx_push_preferences: (_args, context) => ({
      data: { preferences: getPushPreferences(db, context.principal.consultantId) },
      facts: [], inferences: [], recommendations: [], unknowns: [], evidence_refs: ['consultant_preferences:self'],
      next_allowed_actions: ['brainx_update_push_preferences'],
    }),
    brainx_update_push_preferences: (args, context) => {
      requireConfirmation(args);
      const out = updatePushPreferences(db, context.principal.consultantId, args);
      if (!out.ok) fail('INVALID_ARGUMENT');
      return { data: out, facts: [{ preference_updated: true }], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: ['consultant_preferences:self'], next_allowed_actions: ['brainx_push_preferences'] };
    },
    brainx_job_contacts: (args, context) => {
      const job = requireVisible(db, context.principal, args.job_id);
      return { data: { job_ref: args.job_id, owner: job.owner_name ? {
        display_name: job.owner_name, owner_ref: job.owner_unique_id || null,
        linked_chat_available: Boolean(job.chat_id),
      } : null }, facts: [], inferences: [], recommendations: [],
      unknowns: job.owner_name ? [] : ['职位负责人尚未同步'], evidence_refs: [`job_fact:${args.job_id}`],
      next_allowed_actions: ['brainx_job_assessment'] };
    },
    brainx_accept_job: (args, context) => acceptJob(db, args, context.principal, startSearch),
    brainx_start_candidate_search: (args, context) => startSearchForJob(db, args, context.principal, startSearch),
    brainx_record_job_progress: (args, context) => recordJobProgress(db, args, context.principal),
  };
}
