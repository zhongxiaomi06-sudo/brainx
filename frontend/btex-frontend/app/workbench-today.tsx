"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, Database, Filter, Search } from "lucide-react";
import type { EngagementState, SyncStatus } from "./decision-demo";
import {
  RecommendationQueueV2Review,
  type RecommendationCardAction,
  type RecommendationQueueItem,
} from "./recommendation-queue-v2-review";
import type { ProjectSummary } from "./brainx-projects-api";
import { PickTray } from "./workbench-pick-tray";
import {
  decisionGroupMeta, verificationJobs, type DecisionAction, type DecisionGroup,
  type DecisionJob, type PickFolder, type SourceMode,
} from "./workbench-model";

type TodayDecisionQueueProps = {
  activeJobId: string | null;
  completed: string[];
  jobs: DecisionJob[];
  projects: ProjectSummary[];
  engagement: Record<string, EngagementState>;
  sync: SyncStatus;
  open: (job: DecisionJob, tab?: "facts" | "judgement" | "engagement" | "trail" | "replay") => void;
  onAction: (job: DecisionJob, action: DecisionAction) => void;
  onAddToProjects: (job: DecisionJob) => Promise<void>;
  onGoToProject: (projectId: string) => void;
  onFeedback: (job: DecisionJob, reason?: string) => void;
  showVerification?: boolean;
  tray: string[];
  onToggleTray: (id: string) => void;
  onRemoveTray: (id: string) => void;
  folders: PickFolder[];
  folderMode: boolean;
  onFolderMode: () => void;
  onAssignFolder: (jobId: string, folderId: string) => void;
  onCreateFolder: (name: string) => void;
  mode: "connecting" | "connected" | "offline";
  onOpenSources: () => void;
  pagination?: {
    pageIndex: number;
    totalCount: number;
    evaluatedCount: number;
    runId: string;
    generatedAt: string;
    policyVersion: string;
    loading: boolean;
    error: string | null;
    newRunAvailable: boolean;
    searchQuery?: string;
    onSearch?: (query: string) => void;
    onPrevious: () => void;
    onNext: () => void;
    onRefreshRun: () => void;
  };
};

function numericFact(value: string | undefined) {
  if (!value || value === "UNKNOWN") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toQueueItem(job: DecisionJob, engagement: EngagementState | undefined, joined: boolean): RecommendationQueueItem {
  const tier = ["TODAY", "WEEK", "VERIFY"].includes(job.facts["决策层级"])
    ? job.facts["决策层级"] as RecommendationQueueItem["tier"] : "VERIFY";
  const confidence = ["SUFFICIENT", "PARTIAL", "INSUFFICIENT"].includes(job.facts["事实可信度"])
    ? job.facts["事实可信度"] as RecommendationQueueItem["confidence"] : "INSUFFICIENT";
  const legalActions: RecommendationCardAction[] = [];
  if (joined) legalActions.push("GO_PROJECT");
  else {
    if (job.brainxLegal?.includes("WATCH") || job.actions.some(action => action.kind === "watch")) legalActions.push("WATCH");
    if (job.eligibility !== "BLOCKED" && job.eligibility !== "EXCLUDED") legalActions.push("ADD");
    if (job.brainxLegal?.includes("DISMISS") || !job.brainxLegal) legalActions.push("DISMISS");
  }
  return {
    projectId: job.id,
    rank: job.rank,
    tier,
    role: job.role,
    company: job.company,
    cities: job.facts["城市"] && job.facts["城市"] !== "UNKNOWN" ? job.facts["城市"].split(/[、,，]/).filter(Boolean) : [],
    relation: job.facts["职位关系"] || null,
    activeState: job.facts["职位状态"] || job.facts["当前状态"] || null,
    hc: numericFact(job.facts["剩余 HC"]),
    currentStage: job.facts["当前阶段"] || null,
    recentActivity: job.facts["最近活动"] && job.facts["最近活动"] !== "UNKNOWN"
      ? { label: job.facts["最近活动"], occurredAt: job.facts["最近活动时间"] || null }
      : null,
    pipeline: job.facts["历史 Pipeline"] || null,
    reasons: job.scoreNotes.slice(0, 2).map((text, index) => ({
      code: `FORMAL_REASON_${index + 1}`,
      text,
      evidence: job.evidence[index] || "推荐运行",
      occurredAt: null,
    })),
    risk: job.risks[0] || null,
    confidence,
    factsUpdatedAt: job.facts["事实更新时间"] && job.facts["事实更新时间"] !== "UNKNOWN"
      ? job.facts["事实更新时间"] : null,
    engagementLabel: null,
    legalActions,
  };
}

export function TodayDecisionQueue(props: TodayDecisionQueueProps) {
  const {
    activeJobId, jobs, projects, engagement, sync, open, onAction, onAddToProjects, onGoToProject, onFeedback,
    showVerification = true, tray, onToggleTray, onRemoveTray,
    folders, folderMode, onFolderMode, onAssignFolder, onCreateFolder, mode,
    onOpenSources, pagination,
  } = props;
  const [localQuery, setLocalQuery] = useState("");
  const [sort, setSort] = useState<"score" | "recent">("score");
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceMode>("all");
  const [groupFilter, setGroupFilter] = useState<"all" | DecisionGroup>("all");
  const [onlyActionable, setOnlyActionable] = useState(false);
  const acceptedJobs = jobs.filter(job => engagement[job.id] === "ACCEPTED");
  const pendingJobs = [...jobs.filter(job => engagement[job.id] !== "ACCEPTED"), ...verificationJobs];
  const pendingShown = showVerification
    ? pendingJobs : pendingJobs.filter(job => !verificationJobs.includes(job));
  const usesQueueSearch = Boolean(pagination?.onSearch);
  const query = usesQueueSearch ? pagination?.searchQuery || "" : localQuery;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchFilteredPending = usesQueueSearch ? pendingShown : pendingShown
    .filter(job => `${job.company} ${job.role} ${job.facts["备注"] || ""}`
      .replace(/<!--[\s\S]*?-->/g, " ").toLocaleLowerCase().includes(normalizedQuery));
  const filteredPending = searchFilteredPending
    .filter(job => sourceFilter === "all" || job.sourceMode === sourceFilter)
    .filter(job => groupFilter === "all" || job.group === groupFilter)
    .filter(job => !onlyActionable || job.actions.length > 0);
  const visiblePending = [...filteredPending].sort((left, right) => sort === "score"
    ? Number(right.finalScore) - Number(left.finalScore)
    : String(left.recentSignal).localeCompare(String(right.recentSignal)));
  const joinedProjects = new Set(projects.map(project => project.project_id));
  const queueItems = visiblePending.map(job => toQueueItem(job, engagement[job.id], joinedProjects.has(job.id)));
  const queueJobs = new Map(visiblePending.map(job => [job.id, job]));
  const allJobs = [...acceptedJobs, ...pendingShown];
  const trayJobs = tray.map(id => allJobs.find(job => job.id === id))
    .filter((job): job is DecisionJob => Boolean(job));
  const isContext = activeJobId !== null && pendingShown.some(job => job.id === activeJobId);
  const queuePagination = pagination || {
    pageIndex: 0, totalCount: queueItems.length, evaluatedCount: queueItems.length,
    runId: "storybook-preview", generatedAt: sync.updatedAt || "时间待确认", policyVersion: "storybook",
    loading: false, error: null, newRunAvailable: false,
    onPrevious: () => undefined, onNext: () => undefined, onRefreshRun: () => undefined,
  };

  const toolbar = <div className="concept-filter-bar">
    <label className="concept-search"><Search/><input value={query} maxLength={120}
      onChange={event => usesQueueSearch ? pagination?.onSearch?.(event.target.value) : setLocalQuery(event.target.value)}
      placeholder="搜索完整队列：职位 / 公司 / JD" aria-label="搜索职位或公司"/>
      {usesQueueSearch && query.trim() && <small className="concept-search-status" role="status">
        {pagination?.loading ? "搜索中…" : `${pagination?.totalCount || 0} 条结果`}</small>}
    </label>
    <label className="concept-filter-select"><span className="sr-only">数据来源</span>
      <select value={sourceFilter} onChange={event => setSourceFilter(event.target.value as "all" | SourceMode)}
        aria-label="数据来源"><option value="all">全部来源</option>
        <option value="COCKPIT_CONTEXT">驾驶舱</option><option value="MARKET_ONLY">职位市场</option>
      </select><ChevronDown/></label>
    <label className="concept-filter-select"><span className="sr-only">推荐阶段</span>
      <select value={groupFilter} onChange={event => setGroupFilter(event.target.value as "all" | DecisionGroup)}
        aria-label="推荐阶段"><option value="all">推荐阶段</option>
        {Object.entries(decisionGroupMeta).map(([value, meta]) => <option key={value} value={value}>{meta.title}</option>)}
      </select><ChevronDown/></label>
    <button type="button" className={`concept-filter-button${onlyActionable ? " is-active" : ""}`}
      aria-pressed={onlyActionable} onClick={() => setOnlyActionable(value => !value)}>
      {onlyActionable ? "显示全部" : "可处理职位"}<Filter/>
    </button>
    <label className="concept-filter-select concept-sort"><span className="sr-only">排序</span>
      <select value={sort} onChange={event => setSort(event.target.value as "score" | "recent")}
        aria-label="职位排序"><option value="score">综合匹配</option><option value="recent">最新信号</option>
      </select><ChevronDown/></label>
  </div>;

  return <div className="decision-home today-workspace">
    {mode === "connected" && jobs.length === 0 && !(usesQueueSearch && query.trim()) ? <section className="decision-empty-source"><Database/>
      <div><h2>还没有可判断的职位</h2><p>TTC 是真实职位的权威来源；RDS 只保存人才数据，不会自动产生职位。请检查 TTC 连接或等待下一次同步。</p></div>
      <button className="btn primary" onClick={onOpenSources}>检查职位连接</button>
    </section> : <>
      {sync.state === "READY" && sync.warning && <div className="sync-degraded-banner" role="status"
        title={sync.warning.detail || undefined}><AlertTriangle/><span>同步失败中：{sync.warning.message} · 当前展示最近完整快照
          {sync.updatedAt ? `（更新于 ${sync.updatedAt}）` : ""}</span></div>}
      {sync.state === "INCOMPLETE" || sync.state === "ERROR" ? <section className="decision-blocked">
        <AlertTriangle/><div><b>{sync.state === "INCOMPLETE" ? "本次同步不完整" : "同步失败"}</b>
          <p>为避免误导，当前不展示新的项目判断。</p></div>
        {jobs[0] && <button className="btn" onClick={() => open(jobs[0], "judgement")}>查看上次快照</button>}
      </section> : <section id="opportunity-list" className={`formal-recommendation-v2${isContext ? " is-context" : ""}`}>
        {toolbar}
        <RecommendationQueueV2Review items={queueItems} pageIndex={queuePagination.pageIndex}
          totalCount={queuePagination.totalCount} evaluatedCount={queuePagination.evaluatedCount}
          runId={queuePagination.runId} generatedAt={queuePagination.generatedAt}
          policyVersion={queuePagination.policyVersion} loading={queuePagination.loading} error={queuePagination.error}
          newRunAvailable={queuePagination.newRunAvailable} onPrevious={queuePagination.onPrevious}
          onNext={queuePagination.onNext} onRefreshRun={queuePagination.onRefreshRun}
          emptyMessage={query.trim() ? `没有找到与“${query.trim()}”匹配的推荐职位` : undefined}
          onOpen={item => { const job = queueJobs.get(item.projectId); if (job) open(job, "judgement"); }}
          onAction={(item, action) => { const job = queueJobs.get(item.projectId); if (!job) return;
            if (action === "DISMISS") { onFeedback(job); return; }
            if (action === "WATCH") { const watch = job.actions.find(candidate => candidate.kind === "watch"); if (watch) onAction(job, watch); else open(job, "engagement"); return; }
            if (action === "ADD") return onAddToProjects(job);
            if (action === "GO_PROJECT") { onGoToProject(job.id); return; }
            open(job, "engagement");
          }} />
      </section>}
      <details className="saved-picks"><summary><span>精选盘</span>
        <small>{trayJobs.length ? `已收藏 ${trayJobs.length} 个职位` : "从上方列表收藏职位，稍后逐个判断"}</small>
        <ChevronDown/></summary><PickTray trayJobs={trayJobs} featuredJobs={visiblePending.slice(0, 4)}
          allJobs={allJobs} folderMode={folderMode} onFolderMode={onFolderMode} folders={folders}
          onRemoveTray={onRemoveTray} onToggleTray={onToggleTray}
          onAssignFolder={onAssignFolder} onCreateFolder={onCreateFolder} open={open}/>
      </details>
    </>}
  </div>;
}
