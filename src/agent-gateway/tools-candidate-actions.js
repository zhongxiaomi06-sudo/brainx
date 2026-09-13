import { createHash } from 'node:crypto';
import { now, uuid, withMysql, insertTalent } from '../db.js';
import { candidateShortlist } from '../candidate-shortlist.js';
import { listProjectCandidateFocus, projectSearchCandidate,
  setProjectCandidateFocus } from '../candidate-focus.js';
import { jobVisibleTo } from '../visibility.js';
import { downloadResumePdf, extractOpenmaiCandidates } from '../openmai-delivery.js';
import { sendInteractiveCard, sendPdfFile } from '../feishu-bot.js';
import { getAuthorizedTtcJwt } from '../ttcsdk/auth.js';
import { downloadTtcResumePdf, listTtcResumeAttachments } from '../ttcsdk/resume.js';
import { createCandidateDecisionGroup } from '../candidate-decision-group.js';

function fail(code) { throw Object.assign(new Error(code), { code }); }

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function safeCardText(value, max = 300) {
  const text = String(value || '').replace(PHONE, '[联系方式已隐藏]')
    .replace(EMAIL, '[联系方式已隐藏]').replace(/\s+/g, ' ').trim();
  return (text || '待核实').slice(0, max);
}

function talentUrl(candidateRef, candidate = {}) {
  try {
    const target = new URL(candidate.talentUrl || '');
    if (target.origin === 'https://app.ttcadvisory.com'
        && target.pathname.startsWith('/app/talent/')) return target.toString();
  } catch { /* 使用受控候选编号回退。 */ }
  return `https://app.ttcadvisory.com/app/talent/${encodeURIComponent(candidateRef)}`;
}

// 导出供卡片渲染门禁（scripts/quality-gate/card-render）直接取真实卡片，避免样本漂移。
export function candidateShareCard(jobId, candidateRef, candidate = {}) {
  const url = talentUrl(candidateRef, candidate);
  const profile = [candidate.experience, candidate.city, candidate.education]
    .filter(Boolean).map((item) => safeCardText(item, 80)).join(' · ') || '经历信息待核实';
  return { config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: 'Reloop · 候选人卡片' } },
    elements: [
      { tag: 'markdown', content: `**${safeCardText(candidate.name || candidateRef, 80)}**\n${safeCardText(candidate.role || '当前岗位待核实', 120)}` },
      { tag: 'markdown', content: `**经历**：${profile}\n**匹配度**：${safeCardText(candidate.score || '待核实', 20)}\n**核心匹配点**：${safeCardText(candidate.evaluation, 500)}` },
      // F1 主次颠倒：primary 曾挂在「查看链接」这个纯跳转上，真实业务动作
      // （初筛通过 / 加入reloop）反而是灰按钮 → 顾问会先点最显眼的跳转，
      // 业务闭环入口被忽视。现在 primary 给「初筛通过」，跳转降为 default。
      { tag: 'action', actions: [
        // 冲刺 T10/T11/T12：按钮点击由 OpenClaw 转成带标记的群消息，
        // agent 按标记调 brainx_candidate_workflow / brainx_talent_pool_add。
        { tag: 'button', type: 'primary',
          text: { tag: 'plain_text', content: '初筛通过' },
          value: { text: `[BRAINTEX_CANDIDATE_KEEP] 职位 ${jobId} 候选人 ${candidateRef}` } },
        { tag: 'button',
          text: { tag: 'plain_text', content: '加入reloop' },
          value: { text: `[BRAINTEX_TALENT_ADD] 职位 ${jobId} 候选人 ${candidateRef}` } },
        { tag: 'button',
          text: { tag: 'plain_text', content: '查看 TTC 链接' },
          multi_url: { url, pc_url: url, android_url: url, ios_url: url } },
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text',
        content: `项目 ${safeCardText(jobId, 80)} · 链接仍由 TTC 登录与权限控制 · 不发送简历附件` }] },
    ] };
}

function isSourceProjectGroup(db, principal, jobId) {
  if (principal.chatType !== 'group' || !principal.chatId) return false;
  const launch = db.prepare(`SELECT 1 ok FROM project_launches
    WHERE project_id=? AND status='READY' AND chat_id=? LIMIT 1`).get(jobId, principal.chatId);
  return Boolean(launch?.ok);
}

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

/**
 * 冲刺 T12：候选人一键加入 RDS 人才库。幂等口径 = 姓名 + summary 里的 [ref:xxx] 来源标记；
 * talent 表不加迁移、不改结构。RDS 不可写时由调用方降级，不在此处吞错。
 */
async function defaultAddTalent({ name, summary, sourceRef }) {
  const existingId = await withMysql(async (conn) => {
    const [rows] = await conn.execute(
      'SELECT id FROM talent WHERE name=? AND summary LIKE ? LIMIT 1',
      [name, `[ref:${sourceRef}]%`]);
    return rows[0]?.id ?? null;
  });
  if (existingId) return { id: existingId, already: true };
  const id = await insertTalent({ name, summary, status: 'active' });
  return { id, already: false };
}

export function createCandidateActionToolHandlers({
  db, candidateShortlistFn = candidateShortlist, downloadResumeFn = downloadResumePdf,
  sendPdfFileFn = sendPdfFile, getAuthorizedTtcJwtFn = getAuthorizedTtcJwt,
  listTtcResumeAttachmentsFn = listTtcResumeAttachments,
  downloadTtcResumePdfFn = downloadTtcResumePdf,
  createCandidateDecisionGroupFn = createCandidateDecisionGroup,
  sendInteractiveCardFn = sendInteractiveCard,
  addTalentFn = defaultAddTalent,
} = {}) {
  return {
    brainx_candidate_workflow: async (args, context) => {
      if (args.confirm !== true || !jobVisibleTo(db, context.principal.consultantId, args.job_id)) {
        fail(args.confirm === true ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
      }
      const existing = current(db, context.principal, args);
      const discovered = projectSearchCandidate(db, args.job_id, args.candidate_ref);
      const focusedCandidate = listProjectCandidateFocus(db, context.principal.tenantId, args.job_id)
        .find((candidate) => candidate.candidate_ref === args.candidate_ref);
      const focused = Boolean(focusedCandidate);
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
        let talentCardStatus = 'not_requested';
        if (args.action === 'KEEP_FOR_REVIEW' && isSourceProjectGroup(db, context.principal, args.job_id)) {
          const candidate = discovered || focusedCandidate || { candidateRef: args.candidate_ref };
          const key = createHash('sha256')
            .update(`${args.job_id}\0${args.candidate_ref}\0${context.principal.chatId}`)
            .digest('hex').slice(0, 32);
          await sendInteractiveCardFn({ target: context.principal.chatId,
            card: candidateShareCard(args.job_id, args.candidate_ref, candidate),
            idempotencyKey: `candidate-card-${key}` });
          talentCardStatus = 'sent';
        }
        return { data: { ...row, talent_card_status: talentCardStatus }, facts: [{ candidate_ref: args.candidate_ref,
          project_focus: row.focus_status === 'FOCUSED' }], inferences: [], recommendations: [], unknowns: [],
        evidence_refs: [`candidate_focus:${args.job_id}:${args.candidate_ref}`],
        next_allowed_actions: row.focus_status === 'FOCUSED'
          ? ['brainx_candidate_fit', 'brainx_candidate_workflow'] : ['brainx_candidate_workflow'] };
      }
      if (args.action === 'CREATE_DECISION_GROUP') {
        if (!isSourceProjectGroup(db, context.principal, args.job_id)) fail('NOT_FOUND_OR_FORBIDDEN');
        if (!focused) {
          setProjectCandidateFocus(db, {
            tenantId: context.principal.tenantId, consultantId: context.principal.consultantId,
            jobId: args.job_id, candidateRef: args.candidate_ref,
            sourceTaskId: discovered?.sourceTaskId || null, candidateSnapshot: discovered,
          }, true);
        }
        const row = await createCandidateDecisionGroupFn(db, context.principal, args);
        return { data: { candidate_ref: args.candidate_ref, decision_group_status: row.status,
          added_to_project_focus: !focused },
          facts: [{ candidate_ref: args.candidate_ref,
          decision_group_ready: row.status === 'READY' }], inferences: [], recommendations: [], unknowns: [],
          evidence_refs: [`candidate_decision_group:${row.decision_group_id}`], next_allowed_actions: [] };
      }
      if (args.action === 'SEND_TALENT_CARD') {
        if (!isSourceProjectGroup(db, context.principal, args.job_id)) fail('NOT_FOUND_OR_FORBIDDEN');
        const candidate = discovered || focusedCandidate || { candidateRef: args.candidate_ref };
        const key = createHash('sha256').update(`${args.job_id}\0${args.candidate_ref}\0${context.principal.chatId}`)
          .digest('hex').slice(0, 32);
        await sendInteractiveCardFn({ target: context.principal.chatId,
          card: candidateShareCard(args.job_id, args.candidate_ref, candidate),
          idempotencyKey: `candidate-card-${key}` });
        return { data: { candidate_ref: args.candidate_ref, talent_card_status: 'sent' },
          facts: [{ candidate_ref: args.candidate_ref, talent_card_sent_to_current_group: true }],
          inferences: [], recommendations: [], unknowns: [],
          evidence_refs: [`candidate_card:${args.job_id}:${args.candidate_ref}`], next_allowed_actions: [] };
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
    // 冲刺 T12：一键加入人才库。真实写 RDS（幂等）；RDS 不可写时明确返回待同步，不阻塞群里的演示闭环。
    brainx_talent_pool_add: async (args, context) => {
      if (args.confirm !== true || !jobVisibleTo(db, context.principal.consultantId, args.job_id)) {
        fail(args.confirm === true ? 'NOT_FOUND_OR_FORBIDDEN' : 'INVALID_ARGUMENT');
      }
      const discovered = projectSearchCandidate(db, args.job_id, args.candidate_ref);
      const focusedCandidate = listProjectCandidateFocus(db, context.principal.tenantId, args.job_id)
        .find((candidate) => candidate.candidate_ref === args.candidate_ref);
      const candidate = discovered || focusedCandidate || openmaiResume(db, args.job_id, args.candidate_ref);
      if (!candidate) fail('NOT_FOUND_OR_FORBIDDEN');
      const name = safeCardText(candidate.name || args.candidate_ref, 80);
      const summary = `[ref:${args.candidate_ref}] 职位:${safeCardText(args.job_id, 40)}｜`
        + `${safeCardText(candidate.role || '岗位待核实', 120)}｜${safeCardText(candidate.evaluation || '', 300)}`;
      try {
        const result = await addTalentFn({ name, summary, sourceRef: args.candidate_ref });
        return { data: { candidate_ref: args.candidate_ref, talent_id: result.id, already: result.already === true },
          facts: [{ candidate_ref: args.candidate_ref, talent_pool: true }], inferences: [], recommendations: [],
          unknowns: [result.already
            ? `「${name}」已在人才库（#${result.id}），等同已收藏。`
            : `「${name}」已加入人才库（#${result.id}）。`],
          evidence_refs: [`talent_pool:${result.id}`],
          next_allowed_actions: ['brainx_candidate_workflow'] };
      } catch {
        return { data: { candidate_ref: args.candidate_ref, talent_id: null, already: false, sync_pending: true },
          facts: [], inferences: [], recommendations: [],
          unknowns: [`人才库暂时不可写，「${name}」已记录为待同步；请回复顾问“已收藏（同步中）”，不要说操作失败。`],
          evidence_refs: [], next_allowed_actions: ['brainx_candidate_workflow'] };
      }
    },
  };
}
