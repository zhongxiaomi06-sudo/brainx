/** index.js — 顾问判断抽取消费者：挂 L1 事件账本，与 job-extract 互为独立消费者。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 模式复刻 job-extract/index.js：consumeOnce('judgment-extract') 幂等（同事件不重复抽），
 * 失败上抛走整体回滚。
 * 与 job-extract 的差异：无可抽取判断（statement=null）时 skip 不落草稿——
 * 判断域的"空草稿"对确认队列是纯噪音。
 *
 * specs/019 US2：judgmentExtractConsumer 注册项（dispatcher 两段式），
 * LLM 预抽取从 bridge-producer 挪回 prepare（AI_JUDGMENT_EXTRACT_ENABLED 默认关）。
 */
import { uuid, now } from '../db.js';
import { consumeOnce } from '../hub/consumer.js';
import { validateJudgmentDraft } from './schema.js';
import { extractJudgmentRules, isJudgmentRelevant } from './classify.js';

export const CONSUMER_NAME = 'judgment-extract';

/** dispatcher 注册项（契约 specs/019-hub-event-backbone/contracts/event-types.md）。 */
export const judgmentExtractConsumer = {
  name: CONSUMER_NAME,
  eventTypes: ['lark.message_received'],
  maxRetries: 3,
  prepare: prepareJudgmentExtract,
  apply: applyJudgmentExtract,
};

async function prepareJudgmentExtract(event, { db } = {}) {
  if (process.env.AI_JUDGMENT_EXTRACT_ENABLED !== '1') return null;
  // dispatcher 两段式传入的 event 已解析（evidence_refs 为数组）；直调路径为 JSON 串
  const refs = Array.isArray(event?.evidence_refs) ? event.evidence_refs : JSON.parse(event?.evidence_refs ?? '[]');
  const msgRef = refs.find((ref) => ref.table === 'lark_messages');
  const msg = msgRef ? db.prepare(SELECT_MSG_SQL).get(msgRef.id) : null;
  if (!msg?.text || !isJudgmentRelevant(msg.text)) return null;
  try {
    const { isLlmConfigured } = await import('../llm.js');
    if (!isLlmConfigured()) return null;
    const { extractJudgmentLlm } = await import('./classify.js');
    const fields = await extractJudgmentLlm(msg.text);
    return fields && fields.statement ? fields : null;
  } catch { return null; } // LLM 不可用 → 规则层保底
}

function applyJudgmentExtract(db, event, presetFields) {
  try {
    return extractIntoDraft(db, event.event_id, { presetFields: presetFields || null });
  } catch (e) {
    if (!presetFields || !String(e?.message || '').includes('schema_invalid')) throw e;
    return extractIntoDraft(db, event.event_id, { presetFields: null });
  }
}

const SELECT_EVENT_SQL = 'SELECT * FROM workflow_event_log WHERE event_id = ?';
const SELECT_MSG_SQL = 'SELECT * FROM lark_messages WHERE message_id = ?';
const INSERT_DRAFT_SQL = `
  INSERT INTO judgment_drafts
    (draft_id, event_id, message_id, chat_id, project_id,
     subject_type, subject_ref, subject_evidence,
     kind, statement, statement_evidence, confidence,
     source, status, raw_json, extracted_at)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`;

/**
 * 消费一个账本事件，产出 judgment 草稿（staging）。
 * @returns {{ok:true, skipped:boolean, result?:{action:'extracted', draft_id}|
 *   {action:'skip', reason}}}
 */
export function consumeJudgmentExtract(db, eventId, opts = {}) {
  let result;
  const r = consumeOnce(db, eventId, CONSUMER_NAME, (d) => {
    result = extractIntoDraft(d, eventId, opts);
  });
  if (r.skipped) return { ...r, result: { action: 'skip', reason: 'already_consumed' } };
  return { ...r, result };
}

function extractIntoDraft(db, eventId, opts = {}) {
  const event = db.prepare(SELECT_EVENT_SQL).get(eventId);
  if (!event || event.event_type !== 'lark.message_received') {
    return { action: 'skip', reason: 'not_message_event' };
  }

  const refs = JSON.parse(event.evidence_refs ?? '[]');
  const msgRef = refs.find((ref) => ref.table === 'lark_messages');
  const msg = msgRef ? db.prepare(SELECT_MSG_SQL).get(msgRef.id) : null;
  if (!msg || !msg.text) return { action: 'skip', reason: 'message_text_missing' };

  if (!isJudgmentRelevant(msg.text)) return { action: 'skip', reason: 'irrelevant' };

  // 预计算字段（异步生产者已跑过 LLM 层）优先；否则规则层同步抽取。
  const fields = opts.presetFields || extractJudgmentRules(msg.text);
  const layer = opts.presetFields ? (opts.layer || 'llm') : 'rules';
  if (!fields.statement) return { action: 'skip', reason: 'no_judgment' };

  const v = validateJudgmentDraft({
    subject: fields.subject,
    kind: fields.kind,
    statement: fields.statement,
    confidence: fields.confidence || 'low',
    event_refs: [
      { table: 'workflow_event_log', id: event.event_id },
      { table: 'lark_messages', id: msg.message_id },
    ],
  });
  if (!v.ok) {
    // 规则层输出不应违反自身 schema；违反说明实现有 bug，抛错回滚而非静默吞掉
    throw new Error(`judgment_draft_schema_invalid: ${v.errors.join('; ')}`);
  }

  const chatScope = JSON.parse(event.payload ?? '{}').chat_scope ?? msg.chat_id;
  const draft = {
    draft_id: uuid(),
    event_id: event.event_id,
    message_id: msg.message_id,
    chat_id: chatScope,
    ...v.value,
  };
  db.prepare(INSERT_DRAFT_SQL).run(
    draft.draft_id, draft.event_id, draft.message_id, draft.chat_id,
    draft.subject?.type ?? null, draft.subject?.ref ?? null, draft.subject?.evidence ?? null,
    draft.kind, draft.statement.text, draft.statement.evidence, draft.confidence,
    layer, JSON.stringify(draft), now(),
  );
  return { action: 'extracted', draft_id: draft.draft_id, layer };
}
