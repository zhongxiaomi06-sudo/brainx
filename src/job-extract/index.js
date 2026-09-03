/** index.js — E1 提炼层主入口：挂 L1 事件账本的消费者。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §4；
 * 关键架构：提炼层不是新服务，是账本的一个消费者——
 * consumeOnce('job-extract') 复用 Step 0 幂等模板（同事件不重复抽，LLM 调用也是钱），
 * 失败上抛走整体回滚（E2 LLM 层失败时由调用方决定进 event_dlq 重放）。
 * AI 开关：AI_JOB_EXTRACT_ENABLED（默认关）——E1 仅规则层；E2 在此挂 LLM 层（rules 保底）。
 */
import { uuid, now } from '../db.js';
import { consumeOnce } from '../hub/consumer.js';
import { validateDraft } from './schema.js';
import { extractRules, isJobRelevant } from './classify.js';

export const CONSUMER_NAME = 'job-extract';

const SELECT_EVENT_SQL = 'SELECT * FROM workflow_event_log WHERE event_id = ?';
const SELECT_MSG_SQL = 'SELECT * FROM lark_messages WHERE message_id = ?';
const INSERT_DRAFT_SQL = `
  INSERT INTO job_facts_drafts
    (draft_id, event_id, message_id, chat_id, project_id,
     company, company_evidence, role, role_evidence, city, city_evidence,
     pipeline_stage, pipeline_evidence, hc, hc_evidence,
     active_state, state_evidence, source, status, raw_json, extracted_at)
  VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`;

/**
 * 消费一个账本事件，产出 job_facts 草稿（staging）。
 * @returns {{ok:true, skipped:boolean, result?:{action:'extracted', draft_id, fields}|
 *   {action:'skip', reason}}}
 */
export function consumeJobExtract(db, eventId, opts = {}) {
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

  if (!isJobRelevant(msg.text)) return { action: 'skip', reason: 'irrelevant' };

  // 预计算字段（异步生产者已跑过 LLM 层）优先；否则规则层同步抽取。
  // LLM 不直接进入本同步链——consumeOnce 是同步模板，提取层只接受注入。
  const fields = opts.presetFields || extractRules(msg.text);
  const layer = opts.presetFields ? (opts.layer || 'llm') : 'rules';
  const draft = buildDraft(event, msg, fields);
  // zod 只校验 schema 覆盖的字段（safeParse 会剥离未知键，元数据用原始 draft 插库）
  const v = validateDraft({
    company: draft.company,
    role: draft.role,
    city: draft.city,
    pipeline: draft.pipeline,
    hc: draft.hc,
    active_state: draft.active_state,
    event_refs: draft.event_refs,
  });
  if (!v.ok) {
    // 规则层输出不应违反自身 schema；违反说明实现有 bug，抛错回滚而非静默吞掉
    throw new Error(`job_facts_draft_schema_invalid: ${v.errors.join('; ')}`);
  }
  insertDraft(db, draft);
  return { action: 'extracted', draft_id: draft.draft_id, fields, layer };
}

function buildDraft(event, msg, fields) {
  const chatScope = JSON.parse(event.payload ?? '{}').chat_scope ?? msg.chat_id;
  return {
    draft_id: uuid(),
    event_id: event.event_id,
    message_id: msg.message_id,
    chat_id: chatScope,
    company: fields.company,
    role: fields.role,
    city: fields.city,
    pipeline: fields.pipeline,
    hc: fields.hc,
    active_state: fields.active_state,
    event_refs: [
      { table: 'workflow_event_log', id: event.event_id },
      { table: 'lark_messages', id: msg.message_id },
    ],
  };
}

function insertDraft(db, d) {
  db.prepare(INSERT_DRAFT_SQL).run(
    d.draft_id,
    d.event_id,
    d.event_refs.find((r) => r.table === 'lark_messages').id,
    d.chat_id,
    d.company?.text ?? null,
    d.company?.evidence ?? null,
    d.role?.text ?? null,
    d.role?.evidence ?? null,
    d.city?.text ?? null,
    d.city?.evidence ?? null,
    d.pipeline?.stage ?? null,
    d.pipeline?.evidence ?? null,
    d.hc?.number ?? null,
    d.hc?.evidence ?? null,
    d.active_state.state,
    d.active_state.evidence,
    'rules',
    JSON.stringify(d),
    now(),
  );
}
