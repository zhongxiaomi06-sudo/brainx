/** 重点候选人决策群：迁移来源项目群的最小必要上下文并建立可恢复群绑定。 */
import { randomUUID } from 'node:crypto';
import { now } from './db.js';
import { createProjectChat, sendInteractiveCard } from './feishu-bot.js';
import { registerChatContext } from './gateway/chat-contexts.js';
import { ensureOpenClawProjectGroup } from './openclaw-group-access.js';
import { listProjectCandidateFocus } from './candidate-focus.js';

const GROUP_PURPOSES = ['candidate_review', 'candidate_action', 'interview_prep'];
const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function fail(code) { throw Object.assign(new Error(code), { code }); }
function safe(value, max = 500) {
  const text = String(value || '').replace(PHONE, '[联系方式已隐藏]').replace(EMAIL, '[联系方式已隐藏]')
    .replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function collaborators(db, principal, jobId) {
  return db.prepare(`SELECT DISTINCT c.open_id FROM job_memberships m
    JOIN consultants c ON c.consultant_id=m.consultant_id AND c.active=1
    JOIN feishu_identity_bindings b ON b.consultant_id=c.consultant_id
      AND b.open_id=c.open_id AND b.binding_status='ACTIVE'
    WHERE m.project_id=? AND m.valid_to IS NULL
      AND b.tenant_id=? AND b.channel_account_id=? ORDER BY c.open_id`)
    .all(jobId, principal.tenantId, principal.accountId).map((row) => row.open_id);
}

function sourceContext(db, sourceChatId, candidate) {
  const needles = [candidate.candidate_ref, candidate.name].filter(Boolean);
  const messages = db.prepare(`SELECT text,create_time FROM lark_messages
    WHERE chat_id=? AND text IS NOT NULL ORDER BY create_time DESC LIMIT 80`).all(sourceChatId)
    .filter((row) => needles.some((needle) => String(row.text).includes(needle)))
    .slice(0, 5).reverse();
  const discussion = messages.map((row) => `- ${safe(row.text, 260)}`).join('\n');
  return [
    `候选人：${safe(candidate.name || candidate.candidate_ref, 80)}（TTC ${safe(candidate.candidate_ref, 80)}）`,
    candidate.role ? `当前岗位：${safe(candidate.role, 120)}` : null,
    candidate.evaluation ? `项目匹配：${safe(candidate.evaluation, 500)}` : null,
    candidate.score ? `原轮次匹配度：${safe(candidate.score, 30)}` : null,
    discussion ? `原项目群相关讨论：\n${discussion}` : '原项目群尚无已记录的候选人专属讨论。',
  ].filter(Boolean).join('\n');
}

function contextCard(job, candidate, summary) {
  const ttcUrl = `https://app.ttcadvisory.com/app/talent/${encodeURIComponent(candidate.candidate_ref)}`;
  const generate = `请生成当前候选人的 Offer 决策报告。调用 brainx_candidate_report，mode=GENERATE，confirm=true。`;
  const update = `请结合本群最新内容更新当前候选人的 Offer 决策报告。调用 brainx_candidate_report，mode=REGENERATE，confirm=true。`;
  return { config: { wide_screen_mode: true },
    header: { template: 'purple', title: { tag: 'plain_text', content: 'BrainTex · 候选人 Offer 决策群' } },
    elements: [
      { tag: 'markdown', content: `**${safe(candidate.name || candidate.candidate_ref, 80)} × ${safe(job.role, 120)}**\n${safe(job.company, 120)} · 项目 ${safe(job.project_id, 80)}` },
      { tag: 'markdown', content: `**从原项目群迁移的上下文摘要**\n${summary}` },
      { tag: 'markdown', content: '**本群讨论目标**\n核实关键风险，并决定：继续评估、进入面试、准备 Offer 或不推进。' },
      { tag: 'action', actions: [
        { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: '查看 TTC 人才' },
          multi_url: { url: ttcUrl, pc_url: ttcUrl, android_url: ttcUrl, ios_url: ttcUrl } },
        { tag: 'button', text: { tag: 'plain_text', content: '生成报告' }, value: { text: generate } },
        { tag: 'button', text: { tag: 'plain_text', content: '更新报告' }, value: { text: update } },
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '本群不展示联系方式或简历原文；有新讨论或电话纪要后也可发送 /report 更新报告。' }] },
    ] };
}

function activate(db, principal, jobId, chatId, openIds, candidateRef) {
  const at = now();
  registerChatContext(db, { chat_id: chatId, bot_mode: 'MENTION_ONLY',
    notes: `candidate-decision:${jobId}:${candidateRef}` });
  db.prepare(`INSERT INTO agent_group_scopes
    (group_scope_id,tenant_id,channel_account_id,chat_id,scope_status,allowed_purposes_json,
     allowed_senders_json,project_refs_json,require_mention,created_at,updated_at)
    VALUES (?,?,?,?,'ACTIVE',?,?,?,?,?,?)
    ON CONFLICT(channel_account_id,chat_id) WHERE scope_status='ACTIVE' DO UPDATE SET
      allowed_purposes_json=excluded.allowed_purposes_json,
      allowed_senders_json=excluded.allowed_senders_json,project_refs_json=excluded.project_refs_json,
      updated_at=excluded.updated_at`).run(randomUUID(), principal.tenantId, principal.accountId, chatId,
    JSON.stringify(GROUP_PURPOSES), JSON.stringify(openIds), JSON.stringify([jobId]), 1, at, at);
}

export async function createCandidateDecisionGroup(db, principal, args, dependencies = {}) {
  if (principal.chatType !== 'group') fail('NOT_FOUND_OR_FORBIDDEN');
  const launch = db.prepare(`SELECT chat_id FROM project_launches
    WHERE project_id=? AND status='READY' ORDER BY created_at LIMIT 1`).get(args.job_id);
  if (!launch || launch.chat_id !== principal.chatId) fail('NOT_FOUND_OR_FORBIDDEN');
  const candidate = listProjectCandidateFocus(db, principal.tenantId, args.job_id)
    .find((item) => item.candidate_ref === args.candidate_ref);
  if (!candidate) fail('CANDIDATE_FOCUS_REQUIRED');
  const job = db.prepare('SELECT project_id,company,role FROM job_facts WHERE project_id=?').get(args.job_id);
  if (!job) fail('NOT_FOUND_OR_FORBIDDEN');
  const summary = sourceContext(db, principal.chatId, candidate);
  let row = db.prepare(`SELECT * FROM candidate_decision_groups
    WHERE tenant_id=? AND position_id=? AND candidate_ref=?`)
    .get(principal.tenantId, args.job_id, args.candidate_ref);
  if (row?.status === 'READY') return row;
  const at = now();
  if (!row) {
    db.prepare(`INSERT INTO candidate_decision_groups
      (decision_group_id,tenant_id,position_id,candidate_ref,created_by,source_chat_id,
       context_summary,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'CREATING_CHAT',?,?)`)
      .run(randomUUID(), principal.tenantId, args.job_id, args.candidate_ref,
        principal.consultantId, principal.chatId, summary, at, at);
    row = db.prepare(`SELECT * FROM candidate_decision_groups
      WHERE tenant_id=? AND position_id=? AND candidate_ref=?`)
      .get(principal.tenantId, args.job_id, args.candidate_ref);
  }
  const createChat = dependencies.createProjectChat || createProjectChat;
  const sendCard = dependencies.sendInteractiveCard || sendInteractiveCard;
  const allowGroup = dependencies.ensureOpenClawGroupAllowed || ensureOpenClawProjectGroup;
  const openIds = [...new Set([principal.senderId, ...collaborators(db, principal, args.job_id)].filter(Boolean))];
  let chatId = row.target_chat_id;
  try {
    if (!chatId) {
      const created = await createChat({
        name: `${candidate.name || candidate.candidate_ref}-${job.role}-Offer决策`,
        description: `BrainTex 候选人决策 · ${args.candidate_ref}`,
        ownerOpenId: principal.senderId, memberOpenIds: openIds,
        idempotencyKey: row.decision_group_id,
      });
      chatId = created.chat_id;
      db.prepare(`UPDATE candidate_decision_groups SET target_chat_id=?,target_chat_name=?,
        status='POSTING_CONTEXT',updated_at=? WHERE decision_group_id=?`)
        .run(chatId, created.name, now(), row.decision_group_id);
    }
    await allowGroup(chatId, openIds);
    await sendCard({ target: chatId, card: contextCard(job, candidate, summary),
      idempotencyKey: `${row.decision_group_id}-context` });
    db.exec('BEGIN');
    try {
      activate(db, principal, args.job_id, chatId, openIds, args.candidate_ref);
      db.prepare(`UPDATE candidate_decision_groups SET status='READY',context_summary=?,
        error_code=NULL,error_message=NULL,updated_at=? WHERE decision_group_id=?`)
        .run(summary, now(), row.decision_group_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } catch (error) {
    db.prepare(`UPDATE candidate_decision_groups SET status='FAILED',error_code=?,error_message=?,updated_at=?
      WHERE decision_group_id=?`).run(error.code || 'CANDIDATE_GROUP_CREATE_FAILED',
      safe(error.message, 240), now(), row.decision_group_id);
    throw error;
  }
  return db.prepare('SELECT * FROM candidate_decision_groups WHERE decision_group_id=?')
    .get(row.decision_group_id);
}
