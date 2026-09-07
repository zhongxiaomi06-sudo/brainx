/** p2p-submit.js — 顾问私聊直接提交 JD 建岗草稿（specs/005-private-jd-job-draft）。
 *
 * 流程：JD 原文 → lark_messages 原文表（证据）→ workflow_event_log（幂等账本）
 *   → LLM/规则抽取 → job_facts_drafts（origin='p2p_jd'，submitted_by=提交人）。
 * 幂等三层：lark_messages 主键去重（message_id 由 sha256(consultant_id+JD) 派生）→
 *   账本 idem_key 唯一 → 草稿 (message_id, submitted_by) 命中短路 + 迁移 0038
 *   部分唯一索引数据库兜底。重复提交安全返回既有草稿。
 * 红线：本入口只产「待确认草稿」；建权威岗位必须经 brainx_review_job_fact 显式确认
 *   （confirmDraft，AI 只提议人做决定）。无证据字段不编造；一个有效字段都没有
 *   不产空草稿（返回 action='no_fields'）。
 */
import { createHash } from 'node:crypto';

import { appendEvent } from '../hub/event-log.js';
import { uuid, now } from '../db.js';

import { extractRules } from './classify.js';
import { validateDraft } from './schema.js';

const INSERT_MSG_SQL = `INSERT OR IGNORE INTO lark_messages
  (message_id, chat_id, message_type, text, mentions_json, create_time, received_at)
  VALUES (?,?,?,?,?,?,?)`;

const SELECT_P2P_DRAFT_SQL =
  'SELECT * FROM job_facts_drafts WHERE message_id=? AND submitted_by=? LIMIT 1';

const INSERT_DRAFT_SQL = `
  INSERT INTO job_facts_drafts
    (draft_id, event_id, message_id, chat_id, project_id,
     company, company_evidence, role, role_evidence, city, city_evidence,
     pipeline_stage, pipeline_evidence, hc, hc_evidence,
     active_state, state_evidence, source, status, raw_json, extracted_at,
     origin, submitted_by)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 'p2p_jd', ?)`;

const MIN_JD_CHARS = 50;

/** 幂等消息身份：含 consultant_id——同一 JD 两人提交各自成草稿（staging 是个人事实）。 */
export function jdMessageId(consultantId, text) {
  return `p2pjd_${createHash('sha256').update(`${consultantId}\n${text}`).digest('hex').slice(0, 24)}`;
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

/** LLM 优先（AI_JOB_EXTRACT_ENABLED=1 且 llm 已配置），失败/违规静默降级规则层。 */
async function extractFields(text) {
  if (process.env.AI_JOB_EXTRACT_ENABLED !== '1') {
    return { fields: extractRules(text), layer: 'rules', extra: null };
  }
  try {
    const { isLlmConfigured } = await import('../llm.js');
    if (!isLlmConfigured()) return { fields: extractRules(text), layer: 'rules', extra: null };
    const { extractJdFields } = await import('./jd-extract.js');
    const out = await extractJdFields(text);
    const hasAny = out.fields && Object.values(out.fields)
      .some((f) => f && (f.text || f.number != null || f.stage || f.state));
    if (hasAny) return { fields: out.fields, layer: 'llm', extra: out.extra };
  } catch { /* LLM 未配置/超时/输出违规 → 规则层保底（不向顾问报错中断） */ }
  return { fields: extractRules(text), layer: 'rules', extra: null };
}

function buildDraft(eventId, messageId, chatId, fields, extra, layer) {
  const draft = {
    draft_id: uuid(),
    event_id: eventId,
    message_id: messageId,
    chat_id: chatId,
    company: fields.company,
    role: fields.role,
    city: fields.city,
    pipeline: fields.pipeline,
    hc: fields.hc,
    active_state: fields.active_state,
    event_refs: [
      { table: 'workflow_event_log', id: eventId },
      { table: 'lark_messages', id: messageId },
    ],
  };
  // salary/requirements 无权威列，随 jd_extra 存档于 raw_json（specs/005 FR-005）
  draft.raw_json = JSON.stringify({ ...draft, jd_extra: extra, layer });
  return draft;
}

function pickForSchema(draft) {
  return {
    company: draft.company, role: draft.role, city: draft.city,
    pipeline: draft.pipeline, hc: draft.hc, active_state: draft.active_state,
    event_refs: draft.event_refs,
  };
}

/**
 * 私聊提交整段 JD。返回
 *   {duplicate:true, draft, message_id, layer} 幂等短路 |
 *   {action:'no_fields', message_id, layer} 无有效字段不产草稿 |
 *   {duplicate:false, action:'extracted', draft_id, message_id, fields, layer, extra}
 * @throws {code:'JD_TOO_SHORT'} 文本不足 50 字
 */
export async function submitPrivateJd(db, { consultant_id, chat_id, text, create_time = null }) {
  if (!consultant_id || !chat_id) fail('MISSING_IDENTITY');
  const norm = String(text ?? '').trim();
  if (norm.length < MIN_JD_CHARS) fail('JD_TOO_SHORT');

  const ts = now();
  const createIso = create_time ? new Date(create_time).toISOString() : ts;
  const messageId = jdMessageId(consultant_id, norm);

  db.prepare(INSERT_MSG_SQL).run(messageId, chat_id, 'text', norm, '[]', createIso, ts);
  const ev = appendEvent(db, {
    event_id: uuid(),
    idem_key: `lark.message_received:${messageId}`,
    event_type: 'lark.message_received',
    actor: `p2p:${consultant_id}`,
    occurred_at: createIso,
    payload: { chat_id, message_id: messageId }, // 正文不进账本（PII 纪律），证据走 lark_messages
    evidence_refs: [{ table: 'lark_messages', id: messageId }],
    schema_version: 1,
  });
  if (!ev.ok) fail(`EVENT_APPEND_FAILED:${ev.reason}`);
  const eventId = ev.event.event_id;

  const existing = db.prepare(SELECT_P2P_DRAFT_SQL).get(messageId, consultant_id);
  if (existing) {
    return { duplicate: true, action: 'draft_exists', message_id: messageId,
             draft: existing, layer: existing.source };
  }

  let { fields, layer, extra } = await extractFields(norm);
  let draft = buildDraft(eventId, messageId, chat_id, fields, extra, layer);
  let v = validateDraft(pickForSchema(draft));
  if (!v.ok && layer === 'llm') {
    // LLM 输出形状违反草稿 schema（如 active_state 非法）→ 整体回退规则层
    ({ fields, layer, extra } = { fields: extractRules(norm), layer: 'rules', extra: null });
    draft = buildDraft(eventId, messageId, chat_id, fields, extra, layer);
    v = validateDraft(pickForSchema(draft));
  }
  if (!v.ok) fail(`DRAFT_SCHEMA_INVALID:${v.errors.join('; ')}`);

  const meaningful = draft.company || draft.role || draft.city || draft.hc
    || draft.pipeline || draft.active_state.state !== 'UNKNOWN';
  if (!meaningful) {
    return { duplicate: false, action: 'no_fields', message_id: messageId, layer };
  }

  db.prepare(INSERT_DRAFT_SQL).run(
    draft.draft_id,
    draft.event_id,
    draft.message_id,
    draft.chat_id,
    draft.company?.text ?? null,
    draft.company?.evidence ?? null,
    draft.role?.text ?? null,
    draft.role?.evidence ?? null,
    draft.city?.text ?? null,
    draft.city?.evidence ?? null,
    draft.pipeline?.stage ?? null,
    draft.pipeline?.evidence ?? null,
    draft.hc?.number ?? null,
    draft.hc?.evidence ?? null,
    draft.active_state.state,
    draft.active_state.evidence,
    layer,
    draft.raw_json,
    ts,
    consultant_id,
  );
  return { duplicate: false, action: 'extracted', draft_id: draft.draft_id,
           message_id: messageId, fields, layer, extra };
}
