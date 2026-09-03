import { createHash } from 'node:crypto';

import { confirmDraft, rejectDraft } from '../job-extract/confirm.js';

const VISIBLE_DRAFT = `
  SELECT d.* FROM job_facts_drafts d
  JOIN chat_contexts c ON c.chat_id=d.chat_id AND c.enabled=1
  JOIN consultant_chats cc ON cc.chat_id=d.chat_id AND cc.consultant_id=?
  JOIN consultants u ON u.consultant_id=cc.consultant_id AND u.active=1`;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function redactEvidence(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已脱敏]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号已脱敏]')
    .slice(0, 300);
}

function chatRef(chatId) {
  return `chat_${createHash('sha256').update(String(chatId)).digest('hex').slice(0, 12)}`;
}

function projection(row) {
  return {
    draft_ref: row.draft_id,
    company: row.company,
    role: row.role,
    city: row.city,
    pipeline_stage: row.pipeline_stage,
    hc: row.hc,
    active_state: row.active_state,
    evidence: {
      company: redactEvidence(row.company_evidence),
      role: redactEvidence(row.role_evidence),
      city: redactEvidence(row.city_evidence),
      pipeline_stage: redactEvidence(row.pipeline_evidence),
      hc: redactEvidence(row.hc_evidence),
      active_state: redactEvidence(row.state_evidence),
    },
    source: row.source,
    source_chat_ref: chatRef(row.chat_id),
    extracted_at: row.extracted_at,
  };
}
function visibleDraft(db, consultantId, draftId) {
  return db.prepare(`${VISIBLE_DRAFT} WHERE d.draft_id=? LIMIT 1`).get(consultantId, draftId);
}

function requireSuccess(result) {
  if (result.ok) return result;
  if (result.status === 404) fail('NOT_FOUND_OR_FORBIDDEN');
  if (result.status === 409) fail('STALE_DATA');
  fail('INVALID_ARGUMENT');
}

export function createJobFactsToolHandlers({ db }) {
  return {
    brainx_pending_job_facts: (args, context) => {
      const limit = args.limit || 10;
      const rows = db.prepare(`${VISIBLE_DRAFT}
        WHERE d.status='pending' ORDER BY d.extracted_at DESC LIMIT ?`)
        .all(context.principal.consultantId, limit);
      return {
        data: { items: rows.map(projection), count: rows.length },
        facts: [], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: rows.map((row) => `lark_message:${row.message_id}`),
        source_versions: { job_facts_drafts: rows[0]?.extracted_at || null },
        next_allowed_actions: rows.length ? ['brainx_review_job_fact'] : [],
      };
    },
    brainx_review_job_fact: (args, context) => {
      if (args.confirm !== true) fail('INVALID_ARGUMENT');
      const row = visibleDraft(db, context.principal.consultantId, args.draft_id);
      if (!row) fail('NOT_FOUND_OR_FORBIDDEN');
      const cid = context.principal.consultantId;
      if (row.status !== 'pending') {
        if (row.confirmed_by === cid && row.status === `${args.action}ed`) {
          return {
            data: { draft_ref: row.draft_id, job_ref: row.project_id, status: row.status, already: true },
            facts: [], inferences: [], recommendations: [], unknowns: [],
            evidence_refs: [`lark_message:${row.message_id}`], next_allowed_actions: [],
          };
        }
        fail('STALE_DATA');
      }
      const result = args.action === 'reject'
        ? rejectDraft(db, { draft_id: row.draft_id, consultant_id: cid })
        : confirmDraft(db, { draft_id: row.draft_id, consultant_id: cid, project_id: args.job_id || null });
      requireSuccess(result);
      return {
        data: {
          draft_ref: row.draft_id,
          job_ref: result.project_id || null,
          status: args.action === 'reject' ? 'rejected' : 'confirmed',
          created: result.created ?? null,
        },
        facts: [{ draft_ref: row.draft_id, status: args.action === 'reject' ? 'rejected' : 'confirmed' }],
        inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`lark_message:${row.message_id}`],
        next_allowed_actions: result.project_id ? ['brainx_job_assessment'] : [],
      };
    },
  };
}
