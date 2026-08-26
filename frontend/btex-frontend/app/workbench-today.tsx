"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, Database, Filter, Search } from "lucide-react";
import type { EngagementState, SyncStatus } from "./decision-demo";
import { DecisionZone } from "./workbench-opportunity";
import { PickTray } from "./workbench-pick-tray";
import {
  decisionGroupMeta, verificationJobs, type DecisionAction, type DecisionGroup,
  type DecisionJob, type PickFolder, type SourceMode,
} from "./workbench-model";

type TodayDecisionQueueProps = {
  activeJobId: string | null;
  completed: string[];
  jobs: DecisionJob[];
  engagement: Record<string, EngagementState>;
  sync: SyncStatus;
  open: (job: DecisionJob, tab?: "judgement" | "engagement" | "trail" | "replay") => void;
  onAction: (job: DecisionJob, action: DecisionAction) => void;
  onFeedback: (job: DecisionJob, reason?: string) => void;
  showVerification?: boolean;
  tray: string[];
  onToggleTray: (id: string) => void;
  onRemoveTray: (id: string) => void;
  onConfirmTray: () => void;
  folders: PickFolder[];
  folderMode: boolean;
  onFolderMode: () => void;
  onAssignFolder: (jobId: string, folderId: string) => void;
  onCreateFolder: (name: string) => void;
  mode: "connecting" | "connected" | "offline";
  onOpenSources: () => void;
};

export function TodayDecisionQueue(props: TodayDecisionQueueProps) {
  const {
    activeJobId, completed, jobs, engagement, sync, open, onAction, onFeedback,
    showVerification = true, tray, onToggleTray, onRemoveTray, onConfirmTray,
    folders, folderMode, onFolderMode, onAssignFolder, onCreateFolder, mode,
    onOpenSources,
  } = props;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"score" | "recent">("score");
  const [sourceFilter, setSourceFilter] = useState<"all" | SourceMode>("all");
  const [groupFilter, setGroupFilter] = useState<"all" | DecisionGroup>("all");
  const [onlyActionable, setOnlyActionable] = useState(false);
  const acceptedJobs = jobs.filter(job => engagement[job.id] === "ACCEPTED");
  const pendingJobs = [...jobs.filter(job => engagement[job.id] !== "ACCEPTED"), ...verificationJobs];
  const pendingShown = showVerification
    ? pendingJobs : pendingJobs.filter(job => !verificationJobs.includes(job));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredPending = pendingShown
    .filter(job => `${job.company} ${job.role} ${job.recommendation} ${Object.values(job.facts).join(" ")}`
      .toLocaleLowerCase().includes(normalizedQuery))
    .filter(job => sourceFilter === "all" || job.sourceMode === sourceFilter)
    .filter(job => groupFilter === "all" || job.group === groupFilter)
    .filter(job => !onlyActionable || job.actions.length > 0);
  const visiblePending = [...filteredPending].sort((left, right) => sort === "score"
    ? Number(right.finalScore) - Number(left.finalScore)
    : String(left.recentSignal).localeCompare(String(right.recentSignal)));
  const allJobs = [...acceptedJobs, ...pendingShown];
  const trayJobs = tray.map(id => allJobs.find(job => job.id === id))
    .filter((job): job is DecisionJob => Boolean(job));
  const isContext = activeJobId !== null && pendingShown.some(job => job.id === activeJobId);

  const toolbar = <div className="concept-filter-bar">
    <label className="concept-search"><Search/><input value={query}
      onChange={event => setQuery(event.target.value)} placeholder="搜索职位 / 公司 / JD 关键词"
      aria-label="搜索职位或公司"/></label>
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
    <section className="today-brief"><div><span className="eyebrow">TODAY&apos;S DECISIONS</span>
      <h1>今天只处理最值得推进的职位</h1><p>按真实推进信号和个人适配排序；先判断，再加入精选或接单。</p></div>
      <dl><div><dt>待判断</dt><dd>{visiblePending.length}</dd></div>
        <div><dt>待核验</dt><dd>{visiblePending.filter(job => job.eligibility === "VERIFY_REQUIRED").length}</dd></div>
        <div><dt>我的项目</dt><dd>{acceptedJobs.length}</dd></div></dl>
    </section>
    {mode === "connected" && jobs.length === 0 ? <section className="decision-empty-source"><Database/>
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
      </section> : <DecisionZone anchorId="opportunity-list" tone="pending" title="待判断职位"
        subtitle="按当前顾问可见范围与最新推进信号排序" jobs={visiblePending} isContext={isContext}
        completed={completed} engagement={engagement} open={open} onAction={onAction}
        onFeedback={onFeedback} tray={tray} onToggleTray={onToggleTray} folderMode={folderMode}
        folders={folders} onAssignFolder={onAssignFolder} toolbar={toolbar}/>}
      <details className="saved-picks"><summary><span>精选与批量接单</span>
        <small>{trayJobs.length ? `已选 ${trayJobs.length} 个职位` : "从上方列表选择职位后，在这里统一确认"}</small>
        <ChevronDown/></summary><PickTray trayJobs={trayJobs} featuredJobs={visiblePending.slice(0, 4)}
          allJobs={allJobs} folderMode={folderMode} onFolderMode={onFolderMode} folders={folders}
          onRemoveTray={onRemoveTray} onToggleTray={onToggleTray} onConfirmTray={onConfirmTray}
          onAssignFolder={onAssignFolder} onCreateFolder={onCreateFolder} open={open}/>
      </details>
    </>}
  </div>;
}
