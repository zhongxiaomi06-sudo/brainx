/** radar.js — 职位雷达与客户洞察的读取层。
 *
 * 可见性语义 = 推荐候选池（与 recommend/scorer 的 hardBlock 同一闸门）：
 *   - 用 relations.js 推导关系（策展行 > TTC 主做 > 他人主做 > 团队池 TEAM_SHARED 默认）；
 *   - 仅跳过显式 NOT_JOINED / UNKNOWN 关系行（与 hardBlock 一致）；
 *   - 详情接口 opportunities/:id 仍走 visibility.js 的 fail-closed 404，两者分工不变。
 * 纪律：只呈现事实字段，不补造运营指标（评分/转化/招聘意愿等以后端正式模型为准）。
 *   cockpit_facts（驾驶舱导入）与 job_facts（职位市场）按 project_id 合并（外键保证存在）。
 */
import { relationMap, deriveRelation } from './relations.js';
import { currentStateMap } from './engagement.js';
import { profileTtcFields, TTC_MAIN_COLUMNS } from './ttc-field-catalog.js';
import { latestTtcFieldReport } from './ttc-field-report.js';

const parseRaw = (value) => {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
};

const citiesOf = (job, raw) => {
  const values = raw.cities || raw.ttc?.cities;
  if (Array.isArray(values)) return values.map((value) => String(value).trim()).filter(Boolean);
  return String(job.city || '').split(/[、,，]/).map((value) => value.trim()).filter(Boolean);
};

const pipelineStepsOf = (raw) => {
  const steps = raw.ttc?.pipeline_steps;
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) return null;
  const normalized = Object.fromEntries(Object.entries(steps)
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0)
    .map(([key, value]) => [key, Number(value)]));
  return Object.keys(normalized).length ? normalized : null;
};

/** 职位雷达行：候选池职位事实 + 关系 + 承接态 +（如有）驾驶舱事实。按最近活动倒序。 */
export function radarRows(db, consultant_id) {
  const jobs = db.prepare('SELECT * FROM job_facts').all();
  const cockpit = db.prepare('SELECT * FROM cockpit_facts').all();
  const cMap = Object.fromEntries(cockpit.map((c) => [c.project_id, c]));
  const relCtx = relationMap(db, consultant_id);
  const engagementStates = currentStateMap(db, consultant_id);
  const rows = [];
  for (const j of jobs) {
    const relation = deriveRelation(relCtx, j.project_id);
    if (relation === 'NOT_JOINED' || relation === 'UNKNOWN') continue;
    const c = cMap[j.project_id];
    const raw = parseRaw(j.raw_json);
    rows.push({
      project_id: j.project_id,
      company: j.company,
      role: j.role,
      city: j.city ?? null,
      cities: citiesOf(j, raw),
      pipeline: j.pipeline ?? null,
      pipeline_steps: pipelineStepsOf(raw),
      hc: j.hc ?? null,
      active_state: j.active_state ?? null,
      priority: j.priority ?? null,
      notes: j.notes ?? null,
      company_type: j.company_type ?? null,
      source_url: j.source_url ?? null,
      captured_at: j.captured_at ?? null,
      owner_name: j.owner_name ?? null,
      relation,
      engagement_state: engagementStates.get(j.project_id)?.state || 'NEW',
      cockpit: c ? {
        membership_status: c.membership_status ?? null,
        current_stage: c.current_stage ?? null,
        stage_confidence: c.stage_confidence ?? null,
        pipeline_snapshot: c.pipeline_snapshot ?? null,
        next_action: c.next_action ?? null,
        cockpit_as_of: c.cockpit_as_of ?? null,
        completeness: c.completeness ?? null,
        source_url: c.source_url ?? null,
      } : null,
    });
  }
  rows.sort((a, b) => String(b.captured_at || '').localeCompare(String(a.captured_at || '')));
  return rows;
}

/** 雷达 API 契约：职位事实 + 当前可见集合的字段能力 + 最近一次 TTC 同步质量报告。 */
export function radarPayload(db, consultant_id) {
  const items = radarRows(db, consultant_id);
  const profile = profileTtcFields(items);
  const allowed = new Set(TTC_MAIN_COLUMNS);
  const field_capabilities = profile.fields
    .filter((field) => allowed.has(field.key))
    .map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
      populated: field.populated,
      coverage: field.coverage,
      display_available: field.display_available,
      filter_available: field.filter_available,
    }));
  return {
    schema_version: profile.schema_version,
    items,
    field_capabilities,
    field_report: latestTtcFieldReport(db, consultant_id),
  };
}

/** 客户洞察行：按公司聚合候选池职位。只呈现可数事实；hc_known 为 null 时绝不写 0。 */
export function clientRows(db, consultant_id) {
  const byCompany = new Map();
  for (const r of radarRows(db, consultant_id)) {
    const cur = byCompany.get(r.company) || {
      company: r.company, company_type: null, job_count: 0, active_jobs: 0,
      hc_known: null, last_activity: null, relations: new Set(), states: new Set(),
    };
    cur.company_type = r.company_type || cur.company_type;
    cur.job_count += 1;
    if (r.active_state === 'OPEN') cur.active_jobs += 1;
    if (r.hc != null) cur.hc_known = (cur.hc_known ?? 0) + r.hc;
    if (!cur.last_activity || String(r.captured_at || '') > String(cur.last_activity)) {
      cur.last_activity = r.captured_at;
    }
    if (r.relation) cur.relations.add(r.relation);
    if (r.active_state) cur.states.add(r.active_state);
    byCompany.set(r.company, cur);
  }
  return [...byCompany.values()]
    .map((c) => ({
      company: c.company,
      company_type: c.company_type,
      job_count: c.job_count,
      active_jobs: c.active_jobs,
      hc_known: c.hc_known,
      last_activity: c.last_activity,
      relations: [...c.relations],
      states: [...c.states],
    }))
    .sort((a, b) => b.active_jobs - a.active_jobs || b.job_count - a.job_count || a.company.localeCompare(b.company));
}
