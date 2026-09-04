/** Versioned, privacy-safe contracts between the talent pipeline and Agent tools. */
import { z } from 'zod';

export const CANDIDATE_FACT_SCHEMA_VERSION = 'candidate_fact_v1';
export const CANDIDATE_MATCH_BUNDLE_SCHEMA_VERSION = 'candidate_match_bundle_v1';

const isoTime = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'must be ISO-8601');
const ref = z.string().min(1).max(160);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i, 'must be a SHA-256 hex digest');
const evidenceRefs = z.array(ref).max(50);
const supportedRefs = evidenceRefs.min(1, 'evidence_refs required for supported fact');

const evidenceSchema = z.strictObject({
  evidence_ref: ref,
  field_path: z.string().min(1).max(240),
  source_ref: ref,
  page: z.number().int().positive().optional(),
  section: z.string().min(1).max(200).optional(),
  char_start: z.number().int().nonnegative().optional(),
  char_end: z.number().int().positive().optional(),
  excerpt_hash: sha256,
}).superRefine((value, ctx) => {
  if (value.char_end !== undefined && value.char_start === undefined) {
    ctx.addIssue({ code: 'custom', path: ['char_start'], message: 'char_start required with char_end' });
  }
  if (value.char_start !== undefined && value.char_end !== undefined && value.char_end <= value.char_start) {
    ctx.addIssue({ code: 'custom', path: ['char_end'], message: 'char_end must be greater than char_start' });
  }
});

const workExperienceSchema = z.strictObject({
  company: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  start_date: z.string().min(4).max(20).nullable().optional(),
  end_date: z.string().min(4).max(20).nullable().optional(),
  is_current: z.boolean().optional(),
  summary: z.string().max(1000).optional(),
  achievements: z.array(z.string().min(1).max(500)).max(20).default([]),
  evidence_refs: supportedRefs,
});

const educationSchema = z.strictObject({
  school: z.string().min(1).max(200),
  degree: z.string().max(100).nullable().optional(),
  major: z.string().max(150).nullable().optional(),
  start_date: z.string().min(4).max(20).nullable().optional(),
  end_date: z.string().min(4).max(20).nullable().optional(),
  evidence_refs: supportedRefs,
});

const skillSchema = z.strictObject({
  name: z.string().min(1).max(120),
  normalized_name: z.string().min(1).max(120),
  proficiency: z.enum(['EXPLICIT', 'UNKNOWN']),
  evidence_refs: supportedRefs,
});

const constraintSchema = z.strictObject({
  name: z.enum(['location', 'salary', 'availability', 'industry_preference', 'other']),
  value: z.string().max(500).nullable(),
  state: z.enum(['SUPPORTED', 'UNKNOWN']),
  evidence_refs: evidenceRefs,
}).superRefine((value, ctx) => {
  if (value.state === 'SUPPORTED' && value.evidence_refs.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['evidence_refs'], message: 'evidence_refs required for supported fact' });
  }
  if (value.state === 'UNKNOWN' && value.value !== null) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'UNKNOWN fact value must be null' });
  }
});

export const candidateFactSchema = z.strictObject({
  schema_version: z.literal(CANDIDATE_FACT_SCHEMA_VERSION),
  fact_version_id: ref,
  candidate_ref: ref,
  document: z.strictObject({
    document_ref: ref,
    source_format: z.enum(['pdf', 'docx', 'text', 'legacy_text']),
    content_hash: sha256,
    parser_version: z.string().min(1).max(120),
    processed_at: isoTime,
  }),
  identity: z.strictObject({
    display_name: z.string().min(1).max(100),
    contact_ref: ref.optional(),
    current_city: z.string().max(100).optional(),
    evidence_refs: supportedRefs,
  }),
  work_experiences: z.array(workExperienceSchema).max(50),
  education: z.array(educationSchema).max(20),
  skills: z.array(skillSchema).max(200),
  constraints: z.array(constraintSchema).max(50),
  evidence: z.array(evidenceSchema).max(500),
  quality: z.strictObject({
    status: z.enum(['READY', 'NEEDS_REVIEW', 'OCR_REQUIRED', 'REJECTED']),
    evidence_coverage: z.number().min(0).max(1),
    unknown_fields: z.array(z.string().min(1).max(240)).max(100),
    warnings: z.array(z.string().min(1).max(500)).max(100),
  }),
}).superRefine((value, ctx) => {
  const known = new Set(value.evidence.map((entry) => entry.evidence_ref));
  const referenced = [
    ...value.identity.evidence_refs,
    ...value.work_experiences.flatMap((entry) => entry.evidence_refs),
    ...value.education.flatMap((entry) => entry.evidence_refs),
    ...value.skills.flatMap((entry) => entry.evidence_refs),
    ...value.constraints.flatMap((entry) => entry.evidence_refs),
  ];
  for (const evidenceRef of referenced) {
    if (!known.has(evidenceRef)) {
      ctx.addIssue({ code: 'custom', path: ['evidence'], message: `missing evidence reference: ${evidenceRef}` });
    }
  }
});

const hardConditionSchema = z.strictObject({
  criterion: z.string().min(1).max(300),
  result: z.enum(['PASS', 'FAIL', 'UNKNOWN']),
  evidence_refs: evidenceRefs,
});

const assessmentSchema = z.strictObject({
  score: z.number().min(0).max(100),
  summary: z.string().min(1).max(1000),
  evidence_refs: evidenceRefs,
});

const jobContextSchema = z.strictObject({
  title: z.string().min(1).max(200),
  summary: z.string().max(1000).nullable(),
  experience_requirement: z.string().max(500).nullable(),
  education_requirement: z.string().max(300).nullable(),
  location: z.string().max(200).nullable(),
  required_skills: z.array(z.string().min(1).max(200)).max(30),
  preferred_skills: z.array(z.string().min(1).max(200)).max(30),
  responsibilities: z.array(z.string().min(1).max(500)).max(10),
  unknowns: z.array(z.string().min(1).max(200)).max(20),
});

const profileSnapshotSchema = z.strictObject({
  current_city: z.string().max(100).nullable(),
  recent_experiences: z.array(z.strictObject({
    company: z.string().min(1).max(200),
    title: z.string().min(1).max(200),
    start_date: z.string().max(20).nullable(),
    end_date: z.string().max(20).nullable(),
    is_current: z.boolean(),
    summary: z.string().max(700).nullable(),
  })).max(4),
  education: z.array(z.strictObject({
    school: z.string().min(1).max(200),
    degree: z.string().max(100).nullable(),
    major: z.string().max(150).nullable(),
  })).max(3),
  skills: z.array(z.string().min(1).max(120)).max(30),
});

export const storedCandidateMatchPayloadSchema = z.strictObject({
  strength_summary: z.string().min(1).max(1000),
  strength_evidence_refs: evidenceRefs,
  job_fit_summary: z.string().min(1).max(1000),
  job_fit_evidence_refs: evidenceRefs,
  hard_conditions: z.array(hardConditionSchema).max(50),
  gaps: z.array(z.string().min(1).max(500)).max(50),
  risks: z.array(z.string().min(1).max(500)).max(50),
  unknowns: z.array(z.string().min(1).max(500)).max(50),
  freshness_status: z.enum(['FRESH', 'STALE', 'UNKNOWN']),
});

const matchItemSchema = z.strictObject({
  candidate_ref: ref,
  display_name_masked: z.string().min(2).max(100),
  rank: z.number().int().positive(),
  profile: profileSnapshotSchema,
  strength: assessmentSchema,
  job_fit: assessmentSchema,
  hard_conditions: z.array(hardConditionSchema).max(50),
  gaps: z.array(z.string().min(1).max(500)).max(50),
  risks: z.array(z.string().min(1).max(500)).max(50),
  unknowns: z.array(z.string().min(1).max(500)).max(50),
  data_freshness: z.strictObject({ fact_processed_at: isoTime, status: z.enum(['FRESH', 'STALE', 'UNKNOWN']) }),
});

export const candidateMatchBundleSchema = z.strictObject({
  schema_version: z.literal(CANDIDATE_MATCH_BUNDLE_SCHEMA_VERSION),
  job_ref: ref,
  job_context: jobContextSchema.nullable(),
  match_run: z.strictObject({
    match_run_id: ref,
    algorithm_version: z.string().min(1).max(120),
    feature_schema_version: z.string().min(1).max(120),
    completed_at: isoTime,
  }).nullable(),
  page: z.strictObject({ limit: z.number().int().min(1).max(20), next_page_token: z.string().min(1).nullable() }),
  items: z.array(matchItemSchema).max(20),
  data_scope: z.strictObject({
    scope: z.literal('authorized_shortlist'),
    purpose: z.enum(['candidate_review', 'interview_prep', 'daily_brief']),
  }),
  generated_at: isoTime,
  empty_reason: z.literal('NO_AUTHORIZED_SHORTLIST').optional(),
}).superRefine((value, ctx) => {
  if (value.match_run === null && value.items.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['match_run'], message: 'match_run required when items are present' });
  }
  if (value.job_context === null && value.items.length > 0) {
    ctx.addIssue({ code: 'custom', path: ['job_context'], message: 'job_context required when items are present' });
  }
});

// 用 \w（字母/数字/下划线）边界而非 \d：SHA-256 哈希与 evidence_ref 是 hex+下划线，
// 里面会出现「1[3-9] + 9 位数字」的连续数字段（如 ev_19459559905f…），用 \d 边界会误报
// SENSITIVE_DATA。真实手机号前后是空格/中文/引号等非 \w 字符，仍会被正常拦截。
const PHONE = /(?<![\w])1[3-9]\d{9}(?![\w])/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function assertNoSensitiveText(value) {
  const serialized = JSON.stringify(value);
  if (PHONE.test(serialized) || EMAIL.test(serialized)) {
    const error = new Error('contract contains direct contact information');
    error.code = 'SENSITIVE_DATA';
    throw error;
  }
}

function parse(schema, input) {
  const result = schema.safeParse(input);
  if (result.success) {
    assertNoSensitiveText(result.data);
    return result.data;
  }
  const error = new Error(result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  error.code = 'SCHEMA_INVALID';
  throw error;
}

export const parseCandidateFact = (input) => parse(candidateFactSchema, input);
export const parseStoredCandidateMatchPayload = (input) => parse(storedCandidateMatchPayloadSchema, input);
export const parseCandidateMatchBundle = (input) => parse(candidateMatchBundleSchema, input);
