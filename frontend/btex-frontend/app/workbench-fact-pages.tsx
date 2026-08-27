"use client";

import { useMemo, useState } from "react";
import { JobDetailCard, type JobDetailReviewData } from "./job-detail-card-review";
import {
  TtcJobsTable,
  type TtcFieldCapability,
  type TtcJobStatus,
  type TtcJobTableRow,
} from "./ttc-jobs-table";
import { ClientInsightsReview, type ClientFactRow } from "./client-insights-review";
import type { BackendClientRow, BackendRadarRow, RadarFieldCapability } from "./brainx-api";

const filterKeys = new Set<TtcFieldCapability["key"]>(["company", "city", "active_state", "hc", "owner_name"]);
const relationLabels: Record<string, string> = {
  MY_JOB: "我的职位",
  PRIMARY_PM: "我是主 PM",
  TEAM_SHARED: "团队共享",
  OTHER_CONSULTANT: "其他顾问主做",
  NOT_JOINED: "未加入",
};

function jobStatus(value?: string | null): TtcJobStatus {
  if (value === "OPEN") return "OPEN";
  if (value === "COOLING") return "COOLING";
  if (value === "CLOSED" || value === "COMPLETED") return "CLOSED";
  return "UNKNOWN";
}

export function toTtcJobRow(row: BackendRadarRow): TtcJobTableRow {
  return {
    projectId: row.project_id,
    role: row.role || "待确认",
    company: row.company || "待确认",
    cities: row.cities || (row.city ? row.city.split("、").filter(Boolean) : []),
    activeState: jobStatus(row.active_state),
    hc: row.hc ?? null,
    pipeline: row.pipeline_steps || null,
    ownerName: row.owner_name || null,
    capturedAt: row.captured_at || null,
  };
}

export function toTtcCapability(field: RadarFieldCapability): TtcFieldCapability | null {
  if (!filterKeys.has(field.key as TtcFieldCapability["key"])) return null;
  return {
    key: field.key as TtcFieldCapability["key"],
    displayAvailable: field.displayAvailable,
    filterAvailable: field.filterAvailable,
    coverage: field.coverage,
  };
}

export function toJobDetail(row: BackendRadarRow): JobDetailReviewData {
  return {
    projectId: row.project_id,
    role: row.role || "职位待确认",
    company: row.company || "公司待确认",
    cities: row.cities || (row.city ? row.city.split("、").filter(Boolean) : []),
    activeState: jobStatus(row.active_state),
    hc: row.hc ?? null,
    pipeline: row.pipeline_steps || null,
    ownerName: row.owner_name || null,
    capturedAt: row.captured_at || null,
    relation: relationLabels[row.relation || ""] || null,
    companyType: row.company_type || null,
    currentStage: row.cockpit?.current_stage || null,
    nextAction: row.cockpit?.next_action || null,
    inMyProjects: row.relation === "MY_JOB" || row.relation === "PRIMARY_PM",
  };
}

function safeSourceUrl(value?: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function toClientFact(row: BackendClientRow): ClientFactRow {
  return {
    company: row.company,
    companyType: row.company_type || null,
    jobCount: row.job_count ?? 0,
    activeJobs: row.active_jobs ?? 0,
    knownHc: row.hc_known ?? null,
    lastActivity: row.last_activity || null,
    relations: row.relations || [],
    states: row.states || [],
  };
}

function WorkbenchJobsPage({ items, capabilities, company, onAddToProjects }: { items: BackendRadarRow[]; capabilities: RadarFieldCapability[]; company?: string | null; onAddToProjects: (projectId: string) => void }) {
  const rows = useMemo(() => items.map(toTtcJobRow).filter(row => !company || row.company === company), [company, items]);
  const fields = useMemo(() => capabilities.map(toTtcCapability).filter((field): field is TtcFieldCapability => field !== null), [capabilities]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedSource = selectedId ? items.find(row => row.project_id === selectedId) || null : null;
  const selected = selectedSource ? toJobDetail(selectedSource) : null;
  const sourceUrl = safeSourceUrl(selectedSource?.cockpit?.source_url);
  return <>{company && <div className="ttc-filter-context">正在查看客户“{company}”的职位</div>}<TtcJobsTable rows={rows} capabilities={fields} onOpen={setSelectedId} />{selected && <JobDetailCard job={selected} onClose={() => setSelectedId(null)} onAddToProjects={onAddToProjects} onOpenSource={sourceUrl ? () => window.open(sourceUrl, "_blank", "noopener,noreferrer") : undefined} />}</>;
}

function WorkbenchClientsPage({ items, onOpenJobs }: { items: BackendClientRow[]; onOpenJobs: (company: string) => void }) {
  const rows = useMemo(() => items.map(toClientFact), [items]);
  return <ClientInsightsReview clients={rows} onOpenJobs={onOpenJobs} />;
}

export { WorkbenchClientsPage, WorkbenchJobsPage };
