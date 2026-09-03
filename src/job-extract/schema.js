/** schema.js — E1 提炼草稿 zod schema（LLM 层与规则层共用的输出契约）。
 *
 * 权威契约: docs/2026-09-02-job-facts-extraction-roadmap.md §5；
 * 机制来源：instructor-js「schema 约束 + 失败重试」（E2 LLM 层用 errors 重问）、
 * langextract「原文锚定」（evidence 必填且须为原文片段）。
 * 字段与 migrations/0031_job_facts_drafts 及 0001_init.job_facts 一一对应。
 */
import { z } from 'zod';

export const PIPELINE_STAGES = ['SOURCING', 'SCREENING', 'INTERVIEW', 'OFFER', 'ONBOARD', 'CLOSED'];
export const ACTIVE_STATES = ['OPEN', 'CLOSED', 'ON_HOLD', 'COMPLETED', 'COOLING', 'UNKNOWN'];

const evidenceField = z.object({
  text: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
});

export const jobFactsDraftSchema = z.object({
  company: evidenceField.nullable(),
  role: evidenceField.nullable(),
  city: evidenceField.nullable(),
  pipeline: z
    .object({
      stage: z.enum(PIPELINE_STAGES),
      evidence: z.string().min(1),
      confidence: z.enum(['high', 'medium', 'low']),
    })
    .nullable(),
  hc: z
    .object({
      number: z.number().int().positive(),
      evidence: z.string().min(1),
      confidence: z.enum(['high', 'medium', 'low']),
    })
    .nullable(),
  active_state: z.object({
    state: z.enum(ACTIVE_STATES),
    evidence: z.string().min(1).nullable(), // UNKNOWN 兜底时无证据
    confidence: z.enum(['high', 'medium', 'low']),
  }),
  event_refs: z
    .array(z.object({ table: z.string().min(1), id: z.string().min(1) }))
    .default([]),
});

/** 校验草稿。返回 {ok:true, value} 或 {ok:false, reason:'schema_invalid', errors}。 */
export function validateDraft(input) {
  const result = jobFactsDraftSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    reason: 'schema_invalid',
    errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
