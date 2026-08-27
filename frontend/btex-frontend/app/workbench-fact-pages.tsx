"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  TtcJobsTable,
  type TtcFieldCapability,
  type TtcJobStatus,
  type TtcJobTableRow,
} from "./ttc-jobs-table";
import { ClientInsightsReview, type ClientFactRow } from "./client-insights-review";
import type { BackendClientRow, BackendRadarRow, RadarFieldCapability } from "./brainx-api";

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

function JobFactDetail({ row, onClose }: { row: TtcJobTableRow; onClose: () => void }) {
  const pipeline = row.pipeline
    ? Object.entries(row.pipeline).filter(([, value]) => value > 0).map(([stage, value]) => `${stage} ${value}`).join(" · ")
    : "待确认";
  return <><button className="client-detail-backdrop" type="button" aria-label="关闭职位事实" onClick={onClose} /><aside className="client-detail" aria-label={`${row.role} 职位事实`}>
    <header><div><span>TTC JOB FACT</span><h2>{row.role}</h2><p>{row.company}</p></div><button type="button" aria-label="关闭职位事实" onClick={onClose}><X /></button></header>
    <dl><div><dt>项目编号</dt><dd>{row.projectId}</dd></div><div><dt>城市</dt><dd>{row.cities.join("、") || "待确认"}</dd></div><div><dt>HC</dt><dd>{row.hc ?? "待确认"}</dd></div><div><dt>主做顾问</dt><dd>{row.ownerName || "待确认"}</dd></div></dl>
    <section><h3>Pipeline</h3><p>{pipeline}</p></section>
    <div className="client-detail-note"><p>这里只展示 TTC 可核验职位事实；推荐判断和承接动作仍从“今日决策”或“我的项目”进入。</p></div>
  </aside></>;
}

function WorkbenchJobsPage({ items, capabilities, company }: { items: BackendRadarRow[]; capabilities: RadarFieldCapability[]; company?: string | null }) {
  const rows = useMemo(() => items.map(toTtcJobRow).filter(row => !company || row.company === company), [company, items]);
  const fields = useMemo(() => capabilities.map(toTtcCapability).filter((field): field is TtcFieldCapability => field !== null), [capabilities]);
  const [selected, setSelected] = useState<TtcJobTableRow | null>(null);
  return <>{company && <div className="ttc-filter-context">正在查看客户“{company}”的职位</div>}<TtcJobsTable rows={rows} capabilities={fields} onOpen={projectId => setSelected(rows.find(row => row.projectId === projectId) || null)} />{selected && <JobFactDetail row={selected} onClose={() => setSelected(null)} />}</>;
}

function WorkbenchClientsPage({ items, onOpenJobs }: { items: BackendClientRow[]; onOpenJobs: (company: string) => void }) {
  const rows = useMemo(() => items.map(toClientFact), [items]);
  return <ClientInsightsReview clients={rows} onOpenJobs={onOpenJobs} />;
}

export { WorkbenchClientsPage, WorkbenchJobsPage };
