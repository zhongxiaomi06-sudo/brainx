/** Convert the existing structured reloop profile into BrainX's strict Agent contracts. */
import { createHash } from 'node:crypto';
import { parseCandidateFact, parseStoredCandidateMatchPayload } from './talent-contracts.js';

const PHONE = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d{9}(?!\d)/g;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object' && !Buffer.isBuffer(value)) return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
};

const text = (value, limit = 500) => String(value ?? '').trim()
  .replace(PHONE, '[已脱敏]').replace(EMAIL, '[已脱敏]').slice(0, limit);

const dateText = (value) => {
  const cleaned = text(value, 20);
  return cleaned.length >= 4 && !/至今|present|current/i.test(cleaned) ? cleaned : null;
};

const list = (value) => {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
};

const meaningful = (value, limit = 500) => {
  const cleaned = text(value, limit);
  return /^(未提供|未知|暂无|无|n\/?a|null|-)$/i.test(cleaned) ? '' : cleaned;
};

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

export const digest = (value) => createHash('sha256')
  .update(JSON.stringify(canonical(value))).digest('hex');

const shortId = (prefix, value) => `${prefix}_${digest(value).slice(0, 48)}`;

function profilePayload(profile) {
  return parseJson(profile.source_payload, {});
}

function sourceItems(profile, key) {
  const payload = profilePayload(profile);
  const nested = payload?.[key]?.items;
  if (Array.isArray(nested)) return nested;
  const direct = parseJson(profile[key === 'work' ? 'work_history' : 'education_history'], []);
  return Array.isArray(direct) ? direct : [];
}

function evidenceBuilder(documentRef) {
  const evidence = [];
  const add = (fieldPath, sourcePath, value) => {
    const cleaned = typeof value === 'string' ? text(value, 2_000) : value;
    const evidenceRef = shortId('ev', { documentRef, fieldPath, sourcePath, cleaned });
    evidence.push({ evidence_ref: evidenceRef, field_path: fieldPath, source_ref: documentRef,
      section: sourcePath, excerpt_hash: digest(cleaned) });
    return evidenceRef;
  };
  return { evidence, add };
}

function skillNames(profile) {
  const payload = profilePayload(profile);
  const values = [
    ...list(profile.skills),
    ...list(profile.tags),
    ...list(payload?.project?.macro?.tech_stack),
  ].map((entry) => typeof entry === 'string' ? entry : entry?.name || entry?.label)
    .map((entry) => text(entry, 120)).filter(Boolean);
  return [...new Set(values.map((entry) => entry.toLowerCase()))]
    .map((normalized) => values.find((entry) => entry.toLowerCase() === normalized)).slice(0, 200);
}

/** Contacts in source_payload are intentionally never traversed or persisted. */
export function buildReloopCandidateFact(profile, { processedAt = new Date().toISOString() } = {}) {
  const candidateRef = `reloop-profile:${profile.id}`;
  const documentRef = candidateRef;
  const { evidence, add } = evidenceBuilder(documentRef);
  const name = text(profile.name || profilePayload(profile)?.basic?.name?.cn_name || '候选人', 100);
  const nameEvidence = add('identity.display_name', 'talent_profiles.name', name);
  const currentCity = text(profile.base_location || profilePayload(profile)?.basic?.location?.[0], 100);

  const workExperiences = sourceItems(profile, 'work').slice(0, 50).flatMap((item, index) => {
    const company = text(item.company_name || item.company, 200);
    const title = text(item.position || item.title, 200);
    if (!company || !title) return [];
    const fieldPath = `work_experiences.${index}`;
    const ref = add(fieldPath, `source_payload.work.items.${index}`, {
      company, title, start: item.start_time, end: item.end_time,
      description: text(item.description, 1_000),
    });
    return [{ company, title,
      start_date: dateText(item.start_time),
      end_date: dateText(item.end_time),
      is_current: /至今|present|current/i.test(String(item.end_time || '')),
      ...(item.description ? { summary: text(item.description, 1_000) } : {}),
      achievements: [], evidence_refs: [ref] }];
  });

  const education = sourceItems(profile, 'education').slice(0, 20).flatMap((item, index) => {
    const school = text(item.school_name || item.school, 200);
    if (!school) return [];
    const ref = add(`education.${index}`, `source_payload.education.items.${index}`, {
      school, degree: item.degree, major: item.major, start: item.start_time, end: item.end_time,
    });
    return [{ school, degree: text(item.degree, 100) || null, major: text(item.major, 150) || null,
      start_date: dateText(item.start_time), end_date: dateText(item.end_time),
      evidence_refs: [ref] }];
  });

  const skills = skillNames(profile).map((nameValue, index) => ({
    name: nameValue, normalized_name: nameValue.toLowerCase(), proficiency: 'EXPLICIT',
    evidence_refs: [add(`skills.${index}`, 'talent_profiles.skills', nameValue)],
  }));

  const constraints = [];
  if (currentCity) constraints.push({ name: 'location', value: currentCity, state: 'SUPPORTED',
    evidence_refs: [add('constraints.location', 'talent_profiles.base_location', currentCity)] });
  const expectedSalary = text(profile.expected_salary, 500);
  if (expectedSalary) constraints.push({ name: 'salary', value: expectedSalary, state: 'SUPPORTED',
    evidence_refs: [add('constraints.salary', 'talent_profiles.expected_salary', expectedSalary)] });

  const normalizedSource = { name, currentCity, workExperiences, education, skills, constraints };
  const contentHash = digest(normalizedSource);
  const fact = {
    schema_version: 'candidate_fact_v1',
    fact_version_id: shortId('rfact', { candidateRef, contentHash }), candidate_ref: candidateRef,
    document: { document_ref: documentRef, source_format: 'legacy_text', content_hash: contentHash,
      parser_version: 'reloop-profile-structured-v1', processed_at: new Date(processedAt).toISOString() },
    identity: { display_name: name, ...(currentCity ? { current_city: currentCity } : {}),
      evidence_refs: [nameEvidence] },
    work_experiences: workExperiences, education, skills, constraints, evidence,
    quality: {
      status: workExperiences.length || education.length || skills.length ? 'READY' : 'NEEDS_REVIEW',
      evidence_coverage: 1,
      unknown_fields: [
        ...(!currentCity ? ['identity.current_city'] : []),
        ...(!expectedSalary ? ['constraints.salary'] : []),
        'constraints.availability',
      ],
      warnings: ['联系方式仅保留在权威源，未进入 Agent 事实契约'],
    },
  };
  return parseCandidateFact(fact);
}

export function normalizeReloopScore(value) {
  if (value === null || value === undefined || value === '') return 0;
  const score = Number(value);
  if (!Number.isFinite(score)) return 0;
  return Number(Math.max(0, Math.min(100, score <= 1 ? score * 100 : score)).toFixed(2));
}

function refsFor(fact, prefixes) {
  return fact.evidence.filter((entry) => prefixes.some((prefix) => entry.field_path.startsWith(prefix)))
    .map((entry) => entry.evidence_ref).slice(0, 50);
}

export function buildReloopMatchPayload(profile, recommendation, criteria = {}, fact) {
  const breakdown = parseJson(recommendation.score_breakdown, {});
  const detail = breakdown?.match_detail || {};
  const skillHits = list(detail.skill_hits).map((entry) => text(entry, 120)).filter(Boolean);
  const requiredSkills = list(criteria.required_skills).map((entry) => meaningful(entry, 120)).filter(Boolean);
  const skillRefs = refsFor(fact, ['skills.']);
  const workRefs = refsFor(fact, ['work_experiences.', 'education.']);
  const locationRefs = refsFor(fact, ['constraints.location']);
  const jobFit = normalizeReloopScore(recommendation.score);
  const years = Number(profile.work_years);
  const role = text(profile.position, 100);
  const company = text(profile.company, 100);
  const strengthParts = [Number.isFinite(years) ? `${Number(years.toFixed(1))} 年经验` : '',
    [company, role].filter(Boolean).join(' / ')].filter(Boolean);
  const fitParts = [`来源系统匹配分 ${jobFit}`];
  if (skillHits.length) fitParts.push(`技能命中：${skillHits.slice(0, 5).join('、')}`);
  const factSkillSet = new Set(fact.skills.map((entry) => entry.normalized_name));
  const hitSet = new Set([...skillHits.map((entry) => entry.toLowerCase()),
    ...requiredSkills.filter((entry) => factSkillSet.has(entry.toLowerCase())).map((entry) => entry.toLowerCase())]);
  const gaps = requiredSkills.filter((entry) => !hitSet.has(entry.toLowerCase()))
    .slice(0, 10).map((entry) => `待确认技能：${entry}`);
  const hardConditions = requiredSkills.slice(0, 20).map((criterion) => {
    const hit = hitSet.has(criterion.toLowerCase());
    return { criterion: `必需技能：${criterion}`, result: hit ? 'PASS' : 'UNKNOWN',
      evidence_refs: hit ? skillRefs : [] };
  });
  const jobLocation = meaningful(criteria.location, 100);
  if (jobLocation) hardConditions.push({ criterion: `工作地点：${jobLocation}`,
    result: 'UNKNOWN', evidence_refs: locationRefs });
  return parseStoredCandidateMatchPayload({
    strength_summary: strengthParts.length ? strengthParts.join('；') : '候选人实力字段有限，需顾问复核',
    strength_evidence_refs: [...workRefs, ...skillRefs].slice(0, 50),
    job_fit_summary: fitParts.join('；'),
    job_fit_evidence_refs: skillRefs,
    hard_conditions: hardConditions, gaps, risks: [],
    unknowns: [...(!profile.expected_salary ? ['期望薪资未确认'] : []), '到岗时间未确认'],
    freshness_status: 'UNKNOWN',
  });
}
