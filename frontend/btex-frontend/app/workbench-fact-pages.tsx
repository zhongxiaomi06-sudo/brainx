"use client";

import { useMemo } from "react";
import type { JobDetailReviewData } from "./job-detail-card-review";
import { mergeOpportunityDetail, toRadarJobDetail } from "./job-detail-data";
import {
  type TtcFieldCapability,
  type TtcJobStatus,
  type TtcJobTableRow,
} from "./ttc-jobs-table";
import { ClientInsightsReview, type ClientFactRow } from "./client-insights-review";
import { JobsWorkspaceReview, type JobsWorkspaceReviewRow } from "./jobs-workspace-review";
import { type BackendClientRow, type BackendRadarRow, type RadarFieldCapability } from "./brainx-api";
import { getOpportunityDetail } from "./brainx-opportunity-api";
import type { ProjectSummary } from "./brainx-projects-api";
import { canIgnoreProject } from "./project-ignore-action";

const filterKeys = new Set<TtcFieldCapability["key"]>(["company", "city", "active_state", "hc", "owner_name"]);
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
  return toRadarJobDetail(row);
}

export function toJobsWorkspaceRow(row: BackendRadarRow): JobsWorkspaceReviewRow {
  const captured = row.captured_at ? Date.parse(row.captured_at) : Number.NaN;
  const engagement = row.engagement_state || "NEW";
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
    workflowState: engagement === "ACCEPTED" ? "FOLLOWING" : engagement === "WATCHED" ? "WATCHING" : "PENDING",
    newThisWeek: Number.isFinite(captured) && Date.now() - captured <= 7 * 86400000,
    relation: row.relation || null,
    companyType: row.company_type || null,
    priority: row.priority || null,
    currentStage: row.cockpit?.current_stage || null,
    nextAction: row.cockpit?.next_action || null,
    notes: row.notes || null,
    sourceUrl: safeSourceUrl(row.cockpit?.source_url || row.source_url),
    engagementState: row.engagement_state || null,
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

type WorkbenchJobsPageProps = {
  items: BackendRadarRow[];
  capabilities: RadarFieldCapability[];
  projects: ProjectSummary[];
  company?: string | null;
  onAddToProjects: (projectId: string) => Promise<void>;
  onIgnoreProject: (project: ProjectSummary) => Promise<void>;
};

function WorkbenchJobsPage({ items, capabilities, projects, company, onAddToProjects, onIgnoreProject }: WorkbenchJobsPageProps) {
  const rows = useMemo(() => items.map(toJobsWorkspaceRow).filter(row => !company || row.company === company), [company, items]);
  const fields = useMemo(() => capabilities.map(toTtcCapability).filter((field): field is TtcFieldCapability => field !== null), [capabilities]);
  const filterCapabilities = useMemo(() => ({
    city: fields.find(field => field.key === "city")?.displayAvailable ?? rows.some(row => row.cities.length > 0),
    activeState: fields.find(field => field.key === "active_state")?.displayAvailable ?? rows.length > 0,
  }), [fields, rows]);
  const loadDetail = async (row: JobsWorkspaceReviewRow) => {
    const source = items.find(item => item.project_id === row.projectId);
    if (!source) throw new Error("职位已不在当前 Radar 快照中");
    return mergeOpportunityDetail(toJobDetail(source), await getOpportunityDetail(row.projectId));
  };
  const openSource = (projectId: string) => {
    const row = items.find(item => item.project_id === projectId);
    const sourceUrl = safeSourceUrl(row?.cockpit?.source_url || row?.source_url);
    if (sourceUrl) window.open(sourceUrl, "_blank", "noopener,noreferrer");
  };
  async function ignoreProject(projectId: string) {
    const project = projects.find(item => item.project_id === projectId);
    if (!project) throw new Error("项目已不在当前列表中");
    await onIgnoreProject(project);
  }

  return <>
    {company && <div className="ttc-filter-context">正在查看客户“{company}”的职位</div>}
    <JobsWorkspaceReview rows={rows} embedded
      dataLabel="真实职位数据 · 来自 TTC 同步快照"
      tipText="筛选真实职位，打开详情后可加入我的项目"
      filterCapabilities={filterCapabilities}
      joinedProjectIds={projects.map(project => project.project_id)}
      ignorableProjectIds={projects.filter(canIgnoreProject).map(project => project.project_id)}
      loadDetail={loadDetail}
      onFollow={onAddToProjects}
      onIgnore={ignoreProject}
      onOpenSource={openSource}
    />
  </>;
}

function WorkbenchClientsPage({ items, onOpenJobs }: { items: BackendClientRow[]; onOpenJobs: (company: string) => void }) {
  const rows = useMemo(() => items.map(toClientFact), [items]);
  return <ClientInsightsReview clients={rows} onOpenJobs={onOpenJobs} />;
}

export { WorkbenchClientsPage, WorkbenchJobsPage };
