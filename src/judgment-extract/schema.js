/** schema.js — 顾问判断抽取草稿 zod schema（LLM 层与规则层共用的输出契约）。
 *
 * 权威契约: docs/2026-09-22-judgment-extraction.md；
 * 机制与 job-extract/schema.js 同源：schema 约束 + 原文锚定（evidence 必填且须为原文片段）。
 * 字段与 migrations/0051_judgment_facts.sql 的 judgment_drafts / judgment_facts 一一对应。
 */
import { z } from 'zod';

export const SUBJECT_TYPES = ['CLIENT_COMPANY', 'PROJECT', 'CANDIDATE', 'GENERAL'];
export const JUDGMENT_KINDS = ['PREFERENCE', 'CONSTRAINT', 'EXCEPTION', 'REJECTION', 'EVALUATION'];
export const CONFIDENCES = ['high', 'medium', 'low'];

export const judgmentDraftSchema = z.object({
  subject: z
    .object({
      type: z.enum(SUBJECT_TYPES),
      ref: z.string().min(1),
      evidence: z.string().min(1),
    })
    .nullable(), // 无明确对象的泛化判断（如"这个赛道现在不看"）允许 subject 为 null
  kind: z.enum(JUDGMENT_KINDS).nullable(),
  statement: z
    .object({
      text: z.string().min(1).max(120),
      evidence: z.string().min(1),
    })
    .nullable(), // statement 为 null 表示本条消息无可抽取判断，消费层应 skip 而非落草稿
  confidence: z.enum(CONFIDENCES),
  event_refs: z
    .array(z.object({ table: z.string().min(1), id: z.string().min(1) }))
    .default([]),
});

/** 校验草稿。返回 {ok:true, value} 或 {ok:false, reason:'schema_invalid', errors}。 */
export function validateJudgmentDraft(input) {
  const result = judgmentDraftSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    reason: 'schema_invalid',
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
