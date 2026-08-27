"use client";

import { useEffect, useMemo, useState } from "react";
import { JobDetailCard, type JobDetailReviewData } from "./job-detail-card-review";
import { mergeOpportunityDetail, toRadarJobDetail } from "./job-detail-data";
import {
  TtcJobsTable,
  type TtcFieldCapability,
  type TtcJobStatus,
  type TtcJobTableRow,
} from "./ttc-jobs-table";
import { ClientInsightsReview, type ClientFactRow } from "./client-insights-review";
import { type BackendClientRow, type BackendRadarRow, type RadarFieldCapability } from "./brainx-api";
import { getOpportunityDetail } from "./brainx-opportunity-api";

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
  const [enriched, setEnriched] = useState<JobDetailReviewData | null>(null);
  const selectedSource = selectedId ? items.find(row => row.project_id === selectedId) || null : null;
  const baseSelected = useMemo(() => selectedSource ? toJobDetail(selectedSource) : null, [selectedSource]);
  const selected = enriched?.projectId === selectedId ? enriched : baseSelected;
  const sourceUrl = safeSourceUrl(selected?.sourceUrl);
  useEffect(() => {
    if (!selectedId || !baseSelected) return;
    let active = true;
    void getOpportunityDetail(selectedId)
      .then(detail => { if (active) setEnriched(mergeOpportunityDetail(baseSelected, detail)); })
      .catch(() => { /* Radar 基础事实仍可展示，详情失败不伪造内容。 */ });
    return () => { active = false; };
  }, [baseSelected, selectedId]);
  return <>{company && <div className="ttc-filter-context">正在查看客户“{company}”的职位</div>}<TtcJobsTable rows={rows} capabilities={fields} onOpen={setSelectedId} />{selected && <JobDetailCard job={selected} onClose={() => setSelectedId(null)} onAddToProjects={onAddToProjects} onOpenSource={sourceUrl ? () => window.open(sourceUrl, "_blank", "noopener,noreferrer") : undefined} />}</>;
}

function WorkbenchClientsPage({ items, onOpenJobs }: { items: BackendClientRow[]; onOpenJobs: (company: string) => void }) {
  const rows = useMemo(() => items.map(toClientFact), [items]);
  return <ClientInsightsReview clients={rows} onOpenJobs={onOpenJobs} />;
}

export { WorkbenchClientsPage, WorkbenchJobsPage };
