/** tools-jd-submit.js — brainx_submit_job_jd：顾问私聊/登记群直接提交整段 JD 建岗草稿。
 *
 * specs/005-private-jd-job-draft + 2026-09-07 群内建岗扩展；权限链沿用 agent-gateway 三段守门
 * （HMAC principal assertion → authorizePrincipal(绑定校验) → 本 handler）。
 * 本工具只产「待确认草稿」（AI 只提议），建权威岗位由提交人经
 * brainx_review_job_fact 显式确认（confirmDraft，人做决定）；
 * confirm_create=true 时视为提交人当场授权——草稿立即转正并可接单（一步建岗）。
 * 群内提交的草稿/职位对本群成员可见（chat_contexts+consultant_chats），私聊仅提交人可见。
 */
import { submitPrivateJd } from '../job-extract/p2p-submit.js';
import { confirmDraft } from '../job-extract/confirm.js';

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

/** confirm_create=true：提交人当场授权，草稿立即转正（授权即可接单）。 */
function authorizeCreate(db, draftId, cid) {
  const c = confirmDraft(db, { draft_id: draftId, consultant_id: cid });
  if (!c.ok) fail(c.status === 409 ? 'STALE_DATA' : 'INVALID_ARGUMENT');
  return c;
}

export function createJdSubmitToolHandlers({ db }) {
  return {
    brainx_submit_job_jd: async (args, context) => {
      if (args.confirm !== true) fail('INVALID_ARGUMENT');
      const cid = context.principal.consultantId;
      const chatId = context.principal.chatId;
      const origin = context.principal.chatType === 'group' ? 'group_jd' : 'p2p_jd';
      const r = await submitPrivateJd(db, { consultant_id: cid, chat_id: chatId, text: args.jd_text, origin });

      if (r.duplicate) {
        const pending = r.draft.status === 'pending';
        const authorized = pending && args.confirm_create === true ? authorizeCreate(db, r.draft.draft_id, cid) : null;
        return {
          data: { draft_ref: r.draft.draft_id, duplicate: true,
                  status: authorized ? 'confirmed' : r.draft.status,
                  job_ref: authorized?.project_id ?? r.draft.project_id ?? null,
                  layer: r.layer, fields: draftProjection(r.draft) },
          facts: [{ draft_ref: r.draft.draft_id, duplicate: true }],
          inferences: [], recommendations: [],
          unknowns: authorized ? [] : (pending ? ['确认草稿后才能接单'] : []),
          evidence_refs: [`lark_message:${r.message_id}`],
          next_allowed_actions: authorized ? ['brainx_accept_job', 'brainx_start_candidate_search'] : (pending ? ['brainx_review_job_fact'] : []),
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
      const authorized = args.confirm_create === true ? authorizeCreate(db, r.draft_id, cid) : null;
      return {
        data: {
          draft_ref: r.draft_id, duplicate: false,
          status: authorized ? 'confirmed' : 'pending', layer: r.layer,
          job_ref: authorized?.project_id ?? null, created: authorized?.created ?? false,
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
        unknowns: authorized ? [] : missing,
        evidence_refs: [`lark_message:${r.message_id}`],
        next_allowed_actions: authorized
          ? ['brainx_accept_job', 'brainx_start_candidate_search']
          : ['brainx_review_job_fact'],
      };
    },
  };
}
