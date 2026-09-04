/** tools-jd-submit.js — brainx_submit_job_jd：顾问私聊直接提交整段 JD 建岗草稿。
 *
 * specs/005-private-jd-job-draft；权限链沿用 agent-gateway 三段守门
 * （HMAC principal assertion → authorizePrincipal(p2pOnly+绑定校验) → 本 handler）。
 * 本工具只产「待确认草稿」（AI 只提议），建权威岗位由提交人经
 * brainx_review_job_fact 显式确认（confirmDraft，人做决定）。
 */
import { submitPrivateJd } from '../job-extract/p2p-submit.js';

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function draftProjection(draft) {
  return {
    draft_ref: draft.draft_id,
    status: draft.status,
    company: draft.company,
    role: draft.role,
    city: draft.city,
    pipeline_stage: draft.pipeline_stage,
    hc: draft.hc,
    active_state: draft.active_state,
    source: draft.source,
    extracted_at: draft.extracted_at,
  };
}

export function createJdSubmitToolHandlers({ db }) {
  return {
    brainx_submit_job_jd: async (args, context) => {
      if (args.confirm !== true) fail('INVALID_ARGUMENT');
      const cid = context.principal.consultantId;
      const chatId = context.principal.chatId;
      const r = await submitPrivateJd(db, { consultant_id: cid, chat_id: chatId, text: args.jd_text });

      if (r.duplicate) {
        const pending = r.draft.status === 'pending';
        return {
          data: { draft_ref: r.draft.draft_id, duplicate: true, status: r.draft.status,
                  layer: r.layer, fields: draftProjection(r.draft) },
          facts: [{ draft_ref: r.draft.draft_id, duplicate: true }],
          inferences: [], recommendations: [], unknowns: [],
          evidence_refs: [`lark_message:${r.message_id}`],
          next_allowed_actions: pending ? ['brainx_review_job_fact'] : [],
        };
      }

      if (r.action === 'no_fields') {
        return {
          data: { draft_ref: null, duplicate: false, action: 'no_fields', layer: r.layer },
          facts: [], inferences: [], recommendations: [],
          unknowns: ['company', 'role', 'city', 'hc'],
          evidence_refs: [`lark_message:${r.message_id}`],
          next_allowed_actions: [],
        };
      }

      const f = r.fields;
      const missing = [
        f.company ? null : 'company', f.role ? null : 'role',
        f.city ? null : 'city', f.hc ? null : 'hc',
      ].filter(Boolean);
      return {
        data: {
          draft_ref: r.draft_id, duplicate: false, status: 'pending', layer: r.layer,
          fields: {
            company: f.company?.text ?? null, role: f.role?.text ?? null,
            city: f.city?.text ?? null, pipeline_stage: f.pipeline?.stage ?? null,
            hc: f.hc?.number ?? null, active_state: f.active_state?.state ?? 'UNKNOWN',
            salary: r.extra?.salary?.text ?? null, requirements: r.extra?.requirements ?? null,
          },
          missing_fields: missing,
        },
        facts: [{ draft_ref: r.draft_id, layer: r.layer }],
        inferences: [], recommendations: [],
        unknowns: missing,
        evidence_refs: [`lark_message:${r.message_id}`],
        next_allowed_actions: ['brainx_review_job_fact'],
      };
    },
  };
}
