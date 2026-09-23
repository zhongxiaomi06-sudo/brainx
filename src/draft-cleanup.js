/** draft-cleanup.js — 草稿 GLM 语义清洗纯逻辑（specs/003 延伸：规则版死草稿复活 + pending 预清洗）。
 *
 * 纪律（2026-09-23 与咪敲定）：
 *  - 全量处理不抽样：A 批 = 全部 rejected（8,132+），B 批 = 全部 pending；
 *  - GLM 只产「建议」，复活/拆稿一律进 pending 等人工确认，绝不直接转正；
 *  - 留痕：复活稿 source='llm-recovery'，拆稿原稿转 rejected 并在 raw_json 记 llm_superseded_by；
 *  - 评审指标不受污染：清洗不发任何评审/确认事件（extract.field_confirm_rate 口径保护）；
 *  - 幂等：复活稿按 (message_id, source='llm-recovery') 查重，重跑不重复。
 */

/** A 批语义三分类的合法判定值。 */
export const CLASSIFY_VALUES = ['REAL_JOB', 'SUSPECTED', 'NOT_JOB'];

/** GLM 分类回复解析：容忍 ```json 围栏、前后杂文本；非法判定返回 null（调用方计 failed）。 */
export function parseClassifyResponse(text) {
  if (!text) return null;
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!CLASSIFY_VALUES.includes(obj.verdict)) return null;
  const out = { verdict: obj.verdict, reason: String(obj.reason || '').slice(0, 300) };
  if (obj.verdict === 'REAL_JOB' && typeof obj.role_hint === 'string' && obj.role_hint.trim()) {
    out.role_hint = obj.role_hint.trim().slice(0, 120);
  }
  return out;
}

/** B 批拆稿回复解析：要求输出 {"jobs":[...]}；空/非法返回 null。 */
export function parseJobsResponse(text) {
  if (!text) return null;
  const m = /\{[\s\S]*\}/.exec(String(text));
  if (!m) return null;
  let obj;
  try { obj = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(obj.jobs)) return null;
  return obj.jobs.filter((j) => j && typeof j === 'object');
}

/** A 批复活稿：从 rejected 草稿 + GLM 判定构造新 pending 草稿行（含幂等与留痕字段）。 */
export function buildRecoveryDraft(rejected, classify, { nowIso, draftId }) {
  if (!classify || classify.verdict !== 'REAL_JOB') return null;
  const role = classify.role_hint || rejected.role || '';
  if (!rejected.company && !role) return null; // 无公司无岗位无从建稿
  const raw = {
    ...safeParse(rejected.raw_json),
    llm_recovery_of: rejected.draft_id,
    llm_reason: classify.reason,
    llm_role_hint: classify.role_hint || null,
  };
  return {
    draft_id: draftId,
    event_id: rejected.event_id,
    message_id: rejected.message_id,
    chat_id: rejected.chat_id,
    project_id: null,
    company: rejected.company || null,
    company_evidence: rejected.company_evidence || null,
    role: role || null,
    role_evidence: classify.role_hint ? `llm:${classify.reason.slice(0, 120)}` : rejected.role_evidence,
    city: rejected.city || null,
    city_evidence: rejected.city_evidence || null,
    pipeline_stage: rejected.pipeline_stage || null,
    pipeline_evidence: rejected.pipeline_evidence || null,
    hc: rejected.hc || null,
    hc_evidence: rejected.hc_evidence || null,
    active_state: rejected.active_state || 'UNKNOWN',
    state_evidence: rejected.state_evidence || null,
    source: 'llm-recovery',
    status: 'pending',
    raw_json: JSON.stringify(raw),
    extracted_at: nowIso,
    origin: rejected.origin || 'group',
  };
}

/** B 批拆稿/纠偏：GLM 建议稿数组 → 新 pending 行列表（原稿由调用方转 rejected 留底）。 */
export function buildSplitDrafts(pending, llmJobs, { nowIso, newId }) {
  const jobs = (Array.isArray(llmJobs) ? llmJobs : []).filter((j) => j && (j.company || j.role));
  if (!jobs.length) return [];
  return jobs.map((j, i) => ({
    draft_id: newId(i),
    event_id: pending.event_id,
    message_id: pending.message_id,
    chat_id: pending.chat_id,
    project_id: null,
    company: strOrNull(j.company),
    company_evidence: strOrNull(j.company_evidence) || strOrNull(j.company),
    role: strOrNull(j.role),
    role_evidence: strOrNull(j.role_evidence),
    city: strOrNull(j.city),
    city_evidence: strOrNull(j.city_evidence),
    pipeline_stage: strOrNull(j.pipeline_stage) || null,
    pipeline_evidence: strOrNull(j.pipeline_evidence),
    hc: j.hc != null && String(j.hc).trim() !== '' ? String(j.hc) : null,
    hc_evidence: strOrNull(j.hc_evidence),
    active_state: strOrNull(j.active_state) || 'UNKNOWN',
    state_evidence: strOrNull(j.state_evidence),
    source: 'llm-split',
    status: 'pending',
    raw_json: JSON.stringify({
      ...safeParse(pending.raw_json),
      llm_split_of: pending.draft_id,
      llm_note: `由草稿 ${pending.draft_id} 拆出第 ${i + 1}/${jobs.length} 个职位`,
    }),
    extracted_at: nowIso,
    origin: pending.origin || 'group',
  }));
}

/** 幂等键：同一消息的复活稿同 source 只允许一条。 */
export function recoveryIdemKey(messageId) {
  return `llm-recovery:${messageId}`;
}

/** 规则缺口对账：GLM 判定 vs 规则版结果的差异归类（report 阶段用）。 */
export function diffAgainstRules(rejected, classify) {
  if (!classify) return { kind: 'no_verdict' };
  if (classify.verdict === 'REAL_JOB' && !rejected.role) return { kind: 'role_missed_by_rules', role_hint: classify.role_hint || null };
  if (classify.verdict === 'REAL_JOB' && !rejected.company) return { kind: 'company_missed_by_rules' };
  if (classify.verdict === 'NOT_JOB' && (rejected.company || rejected.role)) return { kind: 'rules_over_extracted' };
  if (classify.verdict === 'SUSPECTED') return { kind: 'ambiguous' };
  return { kind: 'agree' };
}

function strOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s.slice(0, 200);
}

function safeParse(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}
