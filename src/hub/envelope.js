/** envelope.js — Step 0 事件信封 zod schema 与 validateEnvelope()。
 *
 * 权威契约: specs/001-step0-event-ledger/spec.md FR-005/FR-006。
 * evidence_refs 只允许 {table, id} 引用（表名+主键），禁止 PII 正文；
 * occurred_at 要求可被 Date 解析的 ISO 8601 字符串。
 */
import { z } from 'zod';

const evidenceRefSchema = z.object({
  table: z.string().min(1),
  id: z.string().min(1),
});

export const envelopeSchema = z.object({
  event_id: z.string().min(1),
  idem_key: z.string().min(1),
  event_type: z.string().min(1),
  case_id: z.string().min(1).nullable().optional(),
  actor: z.string().min(1),
  occurred_at: z
    .string()
    .refine((s) => !Number.isNaN(Date.parse(s)), 'occurred_at 必须是 ISO 8601 字符串'),
  payload: z.record(z.string(), z.unknown()),
  evidence_refs: z.array(evidenceRefSchema).default([]),
  schema_version: z.number().int().positive().default(1),
});

/** 校验事件信封。返回 {ok:true, value} 或 {ok:false, reason:'schema_invalid', errors}。 */
export function validateEnvelope(input) {
  const result = envelopeSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    reason: 'schema_invalid',
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
