import { brainxFetch } from "./brainx-http.ts";

export type BackendRadarRow = {
  project_id: string;
  company?: string;
  role?: string;
  city?: string | null;
  cities?: string[];
  pipeline?: string | null;
  pipeline_steps?: Record<string, number> | null;
  owner_name?: string | null;
  hc?: number | null;
  active_state?: string | null;
  priority?: string | null;
  notes?: string | null;
  source_url?: string | null;
  relation?: string | null;
  company_type?: string | null;
  captured_at?: string | null;
  engagement_state?: string;
  cockpit?: {
    membership_status?: string | null;
    current_stage?: string | null;
    stage_confidence?: string | null;
    pipeline_snapshot?: string | null;
    next_action?: string | null;
    cockpit_as_of?: string | null;
    completeness?: string | null;
    source_url?: string | null;
  } | null;
};

export type BackendClientRow = {
  company: string;
  company_type?: string | null;
  job_count?: number;
  active_jobs?: number;
  hc_known?: number | null;
  last_activity?: string | null;
  relations?: string[];
  states?: string[];
};

type BackendTtcFieldCapability = {
  key: string;
  label: string;
  kind: string;
  populated: number;
  coverage: number;
  display_available: boolean;
  filter_available: boolean;
};

type BackendTtcFieldReport = {
  sync_id: string;
  consultant_id: string;
  created_at: string;
  schema_version: string;
  total_rows: number;
  rows_expected: number;
  rows_read: number;
  complete: boolean;
  errors: string[];
  warnings: string[];
  fields: BackendTtcFieldCapability[];
};

type BackendRadarPayload = {
  schema_version: string;
  items: BackendRadarRow[];
  field_capabilities: BackendTtcFieldCapability[];
  field_report: BackendTtcFieldReport | null;
};

export type RadarPositionType = "技术" | "产品" | "运营" | "算法" | "设计" | "商业化";
export type RadarJobStatus = "待同步" | "活跃" | "降温" | "已关闭";

export type RadarJob = {
  id: string;
  name: string;
  client: string;
  industry: string;
  city: string;
  cities: string[];
  pm: string;
  status: RadarJobStatus;
  score: number | null;
  hc: number | null;
  pipelineSteps: Record<string, number> | null;
  ownerName: string | null;
  feedback: string;
  recommended: number | null;
  interview: number | null;
  offer: number | null;
  reason: string;
  salary: string;
  source: "市场信号" | "驾驶舱导入";
  positionType: RadarPositionType;
  sourceColumn?: string;
};

export type RadarFieldCapability = {
  key: string;
  label: string;
  kind: string;
  populated: number;
  coverage: number;
  displayAvailable: boolean;
  filterAvailable: boolean;
};

export type RadarPayload = {
  schemaVersion: string;
  items: BackendRadarRow[];
  fieldCapabilities: RadarFieldCapability[];
  fieldReport: RadarFieldReport | null;
};

export type RadarFieldReport = {
  syncId: string;
  consultantId: string;
  createdAt: string;
  schemaVersion: string;
  totalRows: number;
  rowsExpected: number;
  rowsRead: number;
  complete: boolean;
  errors: string[];
  warnings: string[];
  fields: RadarFieldCapability[];
};

export type RadarClient = {
  name: string;
  industry: string;
  state: string;
  active: number;
  hc: number | null;
  feedback: string;
  r2i: string;
  i2o: string;
  hires: number | null;
  intent: string;
  score: number | null;
  risk: string;
};

const relationLabels: Record<string, string> = {
  MY_JOB: "我的职位",
  PRIMARY_PM: "我是主 PM",
  TEAM_SHARED: "团队共享",
  OTHER_CONSULTANT: "其他顾问主做",
};

export function classifyRadarPositionType(role: string): RadarPositionType {
  const value = String(role || "").replace(/\s+/g, " ").trim();
  if (/设计|UI\s*\/?\s*UX|视觉/i.test(value)) return "设计";
  if (/算法|大模型|机器学习|深度学习|研究|Research|MLE|VLM|NLP|RAG|LLM/i.test(value)) return "算法";
  if (/运营|社群|社区|助理|财务|FA\b|KOL/i.test(value)) return "运营";
  if (/产品(经理|负责人|总监|设计|策略|运营|市场|增长|商业化|&)|\bPM\b|Product/i.test(value)) return "产品";
  if (/增长|市场|投放|销售|商务|品牌|GTM|售前|招聘|HR|BD|营销|内容|CMO/i.test(value)) return "商业化";
  if (/工程|研发|开发|前端|后端|全栈|运维|测试|架构|技术|CTO|iOS|Android|Engineer/i.test(value)) return "技术";
  if (/产品/i.test(value)) return "产品";
  return "商业化";
}

function radarStatusOf(activeState?: string | null): RadarJobStatus {
  if (activeState === "OPEN") return "活跃";
  if (activeState === "COOLING") return "降温";
  if (activeState === "CLOSED" || activeState === "COMPLETED") return "已关闭";
  return "待同步";
}

export function mapRadarRow(row: BackendRadarRow): RadarJob {
  const cockpit = row.cockpit || null;
  const pm = relationLabels[row.relation || ""] || row.relation || "团队共享";
  let reason = "市场信号 · 待后端同步";
  if (cockpit) {
    const membership = { PRIMARY_PM: "我主做", PARTICIPANT: "参与", MENTIONED: "被提及", UNCONFIRMED: "待确认" }[cockpit.membership_status || ""] || cockpit.membership_status || "待确认";
    reason = `驾驶舱 · ${membership} · ${cockpit.current_stage || "阶段待确认"}${cockpit.next_action ? ` · ${cockpit.next_action}` : ""}`;
  } else if (row.pipeline) reason = `Pipeline · ${row.pipeline}`;
  return {
    id: row.project_id,
    name: row.role || "未知职位",
    client: row.company || "未知客户",
    industry: row.company_type || "未标注业务方向",
    city: row.city || "待确认",
    cities: row.cities || (row.city ? row.city.split("、").filter(Boolean) : []),
    pm,
    status: radarStatusOf(row.active_state),
    score: null,
    hc: row.hc ?? null,
    pipelineSteps: row.pipeline_steps || null,
    ownerName: row.owner_name || null,
    feedback: row.captured_at ? String(row.captured_at).slice(0, 10) : "待接入",
    recommended: null,
    interview: null,
    offer: null,
    reason,
    salary: "待同步",
    source: cockpit ? "驾驶舱导入" : "市场信号",
    positionType: classifyRadarPositionType(row.role || ""),
    sourceColumn: cockpit ? "驾驶舱导入" : undefined,
  };
}

export function mapClientRow(client: BackendClientRow): RadarClient {
  const relations = client.relations || [];
  const states = client.states || [];
  let risk = "运营指标待后端接入";
  if (relations.includes("OTHER_CONSULTANT")) risk = "其他顾问主做";
  else if (states.includes("COOLING")) risk = "有职位进入冷却期";
  return {
    name: client.company,
    industry: client.company_type || "未标注业务方向",
    state: (client.active_jobs ?? 0) > 0 ? "有活跃职位" : "无活跃职位",
    active: client.active_jobs ?? 0,
    hc: client.hc_known ?? null,
    feedback: client.last_activity ? String(client.last_activity).slice(0, 10) : "—",
    r2i: "待后端",
    i2o: "待后端",
    hires: null,
    intent: "待确认",
    score: null,
    risk,
  };
}

const mapCapability = (field: BackendTtcFieldCapability): RadarFieldCapability => ({
  key: field.key,
  label: field.label,
  kind: field.kind,
  populated: field.populated,
  coverage: field.coverage,
  displayAvailable: field.display_available,
  filterAvailable: field.filter_available,
});

const mapFieldReport = (report: BackendTtcFieldReport | null): RadarFieldReport | null => report ? ({
  syncId: report.sync_id,
  consultantId: report.consultant_id,
  createdAt: report.created_at,
  schemaVersion: report.schema_version,
  totalRows: report.total_rows,
  rowsExpected: report.rows_expected,
  rowsRead: report.rows_read,
  complete: report.complete,
  errors: report.errors,
  warnings: report.warnings,
  fields: report.fields.map(mapCapability),
}) : null;

export async function getRadar(): Promise<RadarPayload> {
  const payload = await brainxFetch<BackendRadarPayload>("/api/v1/radar");
  return {
    schemaVersion: payload.schema_version,
    items: payload.items,
    fieldCapabilities: payload.field_capabilities.map(mapCapability),
    fieldReport: mapFieldReport(payload.field_report),
  };
}

export async function getTtcFieldReport(): Promise<RadarFieldReport | null> {
  const payload = await brainxFetch<{ report: BackendTtcFieldReport | null }>("/api/v1/ttc/field-report");
  return mapFieldReport(payload.report);
}

export async function getClients(): Promise<{ items: BackendClientRow[] }> {
  return brainxFetch<{ items: BackendClientRow[] }>("/api/v1/clients");
}
