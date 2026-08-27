"use client";

import { useMemo, useState } from "react";
import {
  ArrowDownUp,
  BriefcaseBusiness,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  Command,
  Filter,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Users,
  X,
} from "lucide-react";
import {
  JobDetailCard,
  type JobDetailEvent,
  type JobDetailRecommendation,
} from "./job-detail-card-review";
import type { TtcJobStatus } from "./ttc-jobs-table";
import "./jobs-workspace-review.css";

export type JobsWorkspaceReviewRow = {
  projectId: string;
  role: string;
  company: string;
  cities: string[];
  activeState: TtcJobStatus;
  hc: number | null;
  pipeline: Record<string, number> | null;
  ownerName: string | null;
  capturedAt: string | null;
  workflowState: "PENDING" | "FOLLOWING" | "WATCHING";
  newThisWeek?: boolean;
  relation?: string | null;
  companyType?: string | null;
  priority?: string | null;
  currentStage?: string | null;
  nextAction?: string | null;
  notes?: string | null;
  recommendation?: JobDetailRecommendation | null;
  events?: JobDetailEvent[];
};

type SavedView = "all" | "pending" | "following" | "new";

type JobsWorkspaceReviewProps = {
  rows: JobsWorkspaceReviewRow[];
  consultant?: string;
  initialSelectedId?: string | null;
  onSync?: () => void;
  onFollow?: (projectId: string) => void;
  onDismiss?: (projectId: string) => void;
  onOpenSource?: (projectId: string) => void;
};

const ttcStatusLabel: Record<TtcJobStatus, string> = {
  OPEN: "活跃",
  COOLING: "冷却",
  CLOSED: "已关闭",
  UNKNOWN: "待确认",
};

const workflowLabel: Record<JobsWorkspaceReviewRow["workflowState"], string> = {
  PENDING: "待处理",
  FOLLOWING: "跟进中",
  WATCHING: "已关注",
};

const views: Array<{ id: SavedView; label: string }> = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待处理" },
  { id: "following", label: "跟进中" },
  { id: "new", label: "本周新增" },
];

const navigation = [
  { label: "今日决策", icon: Sparkles },
  { label: "全部职位", icon: BriefcaseBusiness, active: true },
  { label: "我的项目", icon: ClipboardCheck },
  { label: "客户洞察", icon: Users },
];

function formatDate(value: string | null) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

export function JobsWorkspaceReview({
  rows,
  consultant = "Mia 钟笑咪",
  initialSelectedId,
  onSync,
  onFollow,
  onDismiss,
  onOpenSource,
}: JobsWorkspaceReviewProps) {
  const [savedView, setSavedView] = useState<SavedView>("all");
  const [query, setQuery] = useState("");
  const [city, setCity] = useState("全部");
  const [status, setStatus] = useState("全部");
  const [tipVisible, setTipVisible] = useState(true);
  const [selectedId, setSelectedId] = useState(initialSelectedId ?? null);

  const counts = useMemo(() => ({
    all: rows.length,
    pending: rows.filter((row) => row.workflowState === "PENDING").length,
    following: rows.filter((row) => row.workflowState === "FOLLOWING").length,
    new: rows.filter((row) => row.newThisWeek).length,
  }), [rows]);
  const cities = useMemo(() => ["全部", ...new Set(rows.flatMap((row) => row.cities))], [rows]);
  const visibleRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return rows.filter((row) => {
      if (savedView === "pending" && row.workflowState !== "PENDING") return false;
      if (savedView === "following" && row.workflowState !== "FOLLOWING") return false;
      if (savedView === "new" && !row.newThisWeek) return false;
      if (city !== "全部" && !row.cities.includes(city)) return false;
      if (status !== "全部" && ttcStatusLabel[row.activeState] !== status) return false;
      if (!normalized) return true;
      return [row.role, row.company, row.ownerName || "", ...row.cities]
        .join(" ").toLocaleLowerCase("zh-CN").includes(normalized);
    });
  }, [city, query, rows, savedView, status]);
  const selected = selectedId ? rows.find((row) => row.projectId === selectedId) || null : null;

  return (
    <div className="jobs-review-shell">
      <aside className="jobs-review-sidebar" aria-label="审核稿主要导航">
        <div className="jobs-review-brand"><span>BX</span><b>BrainX</b></div>
        <nav>
          {navigation.map(({ label, icon: Icon, active }) => (
            <button type="button" className={active ? "active" : ""} key={label} aria-current={active ? "page" : undefined}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="jobs-review-account">
          <span>{consultant.trim().slice(0, 1) || "M"}</span>
          <span><b>{consultant}</b><small>高级顾问</small></span>
          <Settings2 aria-hidden="true" />
        </div>
      </aside>

      <section className="jobs-review-workspace">
        <header className="jobs-review-topbar">
          <div className="jobs-review-breadcrumb"><span>职位</span><b>/</b><strong>全部职位</strong></div>
          <label className="jobs-review-search">
            <Search aria-hidden="true" />
            <input aria-label="搜索职位工作区" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索职位、公司、城市或顾问" />
            <kbd><Command aria-hidden="true" /> K</kbd>
          </label>
          <button className="jobs-review-sync" type="button" onClick={onSync}><RefreshCw aria-hidden="true" />同步职位</button>
        </header>

        <div className="jobs-review-body">
          <main className="jobs-review-main">
            <div className="jobs-review-tabs" role="tablist" aria-label="职位视图">
              {views.map((view) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={savedView === view.id}
                  className={savedView === view.id ? "active" : ""}
                  onClick={() => setSavedView(view.id)}
                  key={view.id}
                >
                  {view.label}<span>{counts[view.id]}</span>
                </button>
              ))}
            </div>

            {tipVisible && (
              <div className="jobs-review-tip">
                <CircleDot aria-hidden="true" />
                <span>从同步真实职位开始，然后筛选并加入跟进</span>
                <button type="button" onClick={() => setTipVisible(false)}>知道了</button>
                <button type="button" aria-label="关闭使用提示" onClick={() => setTipVisible(false)}><X aria-hidden="true" /></button>
              </div>
            )}

            <div className="jobs-review-toolbar">
              <label>城市<select aria-label="筛选城市" value={city} onChange={(event) => setCity(event.target.value)}>{cities.map((item) => <option key={item}>{item}</option>)}</select><ChevronDown aria-hidden="true" /></label>
              <label>状态<select aria-label="筛选职位状态" value={status} onChange={(event) => setStatus(event.target.value)}>{["全部", "活跃", "冷却", "已关闭", "待确认"].map((item) => <option key={item}>{item}</option>)}</select><ChevronDown aria-hidden="true" /></label>
              <button type="button"><Filter aria-hidden="true" />筛选</button>
              <button type="button"><ArrowDownUp aria-hidden="true" />排序</button>
              {(query || city !== "全部" || status !== "全部") && <button className="reset" type="button" onClick={() => { setQuery(""); setCity("全部"); setStatus("全部"); }}>清除条件</button>}
            </div>

            <div className="jobs-review-table-wrap">
              <table>
                <thead><tr><th>职位名称</th><th>公司</th><th>城市</th><th>HC</th><th>最近更新</th><th>状态</th><th>负责人</th></tr></thead>
                <tbody>
                  {visibleRows.map((row) => (
                    <tr key={row.projectId} className={selected?.projectId === row.projectId ? "selected" : ""} onClick={() => setSelectedId(row.projectId)}>
                      <td><button type="button" onClick={() => setSelectedId(row.projectId)}><span className="jobs-review-company-mark">{row.company.trim().slice(0, 1) || "?"}</span><span><b>{row.role || "待确认"}</b><small>{row.projectId}</small></span></button></td>
                      <td>{row.company || "待确认"}</td>
                      <td>{row.cities.length ? row.cities.join("、") : "待确认"}</td>
                      <td>{row.hc ?? "待确认"}</td>
                      <td>{formatDate(row.capturedAt)}</td>
                      <td><span className={`jobs-review-status is-${row.workflowState.toLowerCase()}`}>{workflowLabel[row.workflowState]}</span></td>
                      <td><span className="jobs-review-owner" title={row.ownerName || "待确认"}>{row.ownerName?.slice(0, 1) || "?"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {visibleRows.length === 0 && <div className="jobs-review-empty"><b>没有符合条件的职位</b><span>调整筛选条件后再试。</span></div>}
              <footer><span>{visibleRows.length} 个结果</span><span>脱敏审核数据 · 字段结构对齐 TTC 职位快照</span></footer>
            </div>
          </main>
        </div>
      </section>
      {selected && (
        <JobDetailCard
          job={{
            projectId: selected.projectId,
            role: selected.role,
            company: selected.company,
            cities: selected.cities,
            activeState: selected.activeState,
            hc: selected.hc,
            pipeline: selected.pipeline,
            ownerName: selected.ownerName,
            capturedAt: selected.capturedAt,
            relation: selected.relation ?? null,
            companyType: selected.companyType,
            priority: selected.priority,
            currentStage: selected.currentStage,
            nextAction: selected.nextAction,
            notes: selected.notes,
            recommendation: selected.recommendation,
            events: selected.events,
            inMyProjects: selected.workflowState === "FOLLOWING",
          }}
          onClose={() => setSelectedId(null)}
          onAddToProjects={(projectId) => onFollow?.(projectId)}
          onDismiss={(projectId) => {
            onDismiss?.(projectId);
            setSelectedId(null);
          }}
          onOpenSource={(projectId) => onOpenSource?.(projectId)}
        />
      )}
    </div>
  );
}
