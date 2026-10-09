import { useEffect, useRef, useState } from "react";
import { BriefcaseBusiness, ChevronRight, X } from "lucide-react";
import type { BrainxReplay, OpenmaiResult } from "./brainx-api";
import { getOpportunityDetail } from "./brainx-opportunity-api";
import type { ProjectSummary } from "./brainx-projects-api";
import {
  decisionGroupMeta,
  stateLabel,
  type AuthStatus,
  type DecisionEvent,
  type EngagementCommand,
  type EngagementState,
  type Notification,
  type Outcome,
  type SyncStatus,
} from "./decision-demo";
import { legalActions, type DecisionAction, type DecisionJob, type MembershipRelation, type Panel } from "./workbench-model";
import { JobDetailCard, type JobDetailReviewData, type JobDetailTab } from "./job-detail-card-review";
import { mergeOpportunityDetail, toDecisionJobDetail } from "./job-detail-data";
import { canIgnoreProject } from "./project-ignore-action";
import { DecisionDrawer } from "./workbench-drawer";
import { SyncPanel, IdentityPanel, NotificationPanel } from "./workbench-side-panels";

function WorkbenchPanel({
  panel,
  motion,
  job,
  projects,
  onIgnoreProject,
  commitmentJobs,
  auth,
  sync,
  notifications,
  engagement,
  events,
  outcomes,
  completed,
  openmaiResults,
  onRerunOpenmai,
  mode,
  legalMap,
  replayMap,
  onReplay,
  onFactsUpdated,
  onCommitmentUpdated,
  onMembership,
  onAcceptAndLaunch,
  onClose,
  onOpenJob,
  onAction,
  onCommand,
  onOutcome,
  onSync,
  onSetSync,
  onAuth,
  onNotification,
  notify,
}: {
  panel: Panel;
  motion: "idle" | "entering" | "open" | "closing";
  job: DecisionJob | null;
  projects: ProjectSummary[];
  onIgnoreProject: (project: ProjectSummary) => Promise<void>;
  commitmentJobs: DecisionJob[];
  auth: AuthStatus;
  sync: SyncStatus;
  notifications: Notification[];
  engagement: Record<string, EngagementState>;
  events: Record<string, DecisionEvent[]>;
  outcomes: Record<string, Outcome[]>;
  completed: string[];
  openmaiResults: Record<string, OpenmaiResult | null>;
  onRerunOpenmai: (jobId: string, searchBrief?: string) => void;
  mode: "connecting" | "connected" | "offline";
  legalMap: Record<string, EngagementCommand[]>;
  replayMap: Record<string, BrainxReplay>;
  onReplay: (jobId: string, data: BrainxReplay) => void;
  onFactsUpdated: () => Promise<void>;
  onCommitmentUpdated: (jobId: string) => Promise<void>;
  onMembership: (job: DecisionJob, relation: MembershipRelation) => Promise<void>;
  onAcceptAndLaunch: (job: DecisionJob) => Promise<void>;
  onClose: () => void;
  onOpenJob: (job: DecisionJob, tab?: JobDetailTab) => void;
  onAction: (job: DecisionJob, action: DecisionAction) => void;
  onCommand: (job: DecisionJob, command: EngagementCommand) => void;
  onOutcome: (job: DecisionJob, stage: Outcome["stage"], rating?: number, note?: string) => void;
  onSync: () => void;
  onSetSync: (sync: SyncStatus) => void;
  onAuth: (auth: AuthStatus) => void;
  onNotification: (notification: Notification) => void;
  notify: (text: string) => void;
}) {
  const [enrichedDetail, setEnrichedDetail] = useState<JobDetailReviewData | null>(null);
  useEffect(() => {
    if (panel?.kind !== "job" || !job || mode !== "connected") return;
    let active = true;
    const base = toDecisionJobDetail(job, events[job.id] || []);
    void getOpportunityDetail(job.id)
      .then((detail) => {
        if (active) setEnrichedDetail(mergeOpportunityDetail(base, detail));
      })
      .catch(() => {
        /* 推荐快照中的基础事实仍可展示，详情失败不伪造内容。 */
      });
    return () => {
      active = false;
    };
  }, [panel?.kind, job, mode, events]);
  const [dragOffset, setDragOffset] = useState<number | null>(null);
  const panelDrag = useRef<{
    pointerId: number;
    startX: number;
    lastX: number;
    lastAt: number;
    velocity: number;
  } | null>(null);
  const startPanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (typeof window === "undefined" || window.innerWidth > 720 || event.button !== 0) return;
    panelDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      lastX: event.clientX,
      lastAt: performance.now(),
      velocity: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragOffset(0);
  };
  const movePanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const now = performance.now();
    const raw = Math.max(0, event.clientX - drag.startX);
    const offset = raw > 260 ? 260 + (raw - 260) * 0.28 : raw;
    drag.velocity = (event.clientX - drag.lastX) / Math.max(1, now - drag.lastAt);
    drag.lastX = event.clientX;
    drag.lastAt = now;
    setDragOffset(offset);
  };
  const finishPanelDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panelDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    panelDrag.current = null;
    const distance = Math.max(0, event.clientX - drag.startX);
    const projected = distance + Math.max(0, drag.velocity) * 150;
    setDragOffset(null);
    if (projected > window.innerWidth * 0.3) onClose();
  };
  if (panel?.kind === "job" && job) {
    const state = engagement[job.id] || "NEW";
    const jobEvents = events[job.id] || [];
    const legal = mode === "connected" ? legalMap[job.id] || [] : legalActions(job, state);
    const baseDetail = toDecisionJobDetail(job, jobEvents);
    const detail = enrichedDetail?.projectId === job.id ? enrichedDetail : baseDetail;
    const currentProject = projects.find((project) => project.project_id === job.id);
    const removableProject = currentProject && canIgnoreProject(currentProject) ? currentProject : null;
    const panelTab = panel.tab === "replay" ? "judgement" : panel.tab; // T1：回放 tab 已下线，历史入口统一落到判断页。
    return (
      <JobDetailCard
        job={{ ...detail, engagementState: stateLabel[state], inMyProjects: Boolean(currentProject) }}
        activeTab={panelTab}
        onTabChange={(tab) => onOpenJob(job, tab)}
        onClose={onClose}
        onAddToProjects={() => onAcceptAndLaunch(job)}
        onIgnore={removableProject ? () => onIgnoreProject(removableProject) : undefined}
        onDismiss={legal.includes("DISMISS") ? () => onCommand(job, "DISMISS") : undefined}
        statusLabel={`${stateLabel[state]} · ${decisionGroupMeta[job.group].title}`}
        detailContent={
          <DecisionDrawer
            job={job}
            tab={panelTab === "facts" ? "judgement" : panelTab}
            completed={completed}
            engagement={state}
            events={jobEvents}
            outcomes={outcomes[job.id] || []}
            openmai={openmaiResults[job.id] || null}
            onRerunOpenmai={onRerunOpenmai}
            mode={mode}
            legalMap={legalMap}
            replayData={replayMap[job.id]}
            onReplay={onReplay}
            onFactsUpdated={onFactsUpdated}
            onCommitmentUpdated={onCommitmentUpdated}
            onMembership={onMembership}
            notify={notify}
            onTab={(tab) => onOpenJob(job, tab)}
            onAction={onAction}
            onCommand={onCommand}
            onOutcome={onOutcome}
          />
        }
      />
    );
  }
  return (
    <aside
      className={`decision-drawer workbench-panel panel-${motion}${dragOffset !== null ? " is-dragging" : ""}`}
      style={{ "--panel-drag-offset": `${dragOffset ?? 0}px` } as React.CSSProperties}
      aria-label="工作台详情面板"
    >
      <div
        className="drawer-drag-handle"
        aria-label="向右滑动关闭详情"
        onPointerDown={startPanelDrag}
        onPointerMove={movePanelDrag}
        onPointerUp={finishPanelDrag}
        onPointerCancel={finishPanelDrag}
      >
        <i />
      </div>
      <button className="drawer-close" onClick={onClose} aria-label="关闭详情">
        <X />
      </button>
      {panel?.kind === "sync" ? (
        <SyncPanel sync={sync} onSync={onSync} onSetSync={onSetSync} notify={notify} mode={mode} />
      ) : panel?.kind === "identity" ? (
        <IdentityPanel auth={auth} onAuth={onAuth} notify={notify} mode={mode} />
      ) : panel?.kind === "commitments" ? (
        <CommitmentsPanel
          jobs={commitmentJobs}
          engagement={engagement}
          onOpen={(job) => onOpenJob(job, "engagement")}
        />
      ) : (
        <NotificationPanel items={notifications} onOpen={onNotification} notify={notify} />
      )}
    </aside>
  );
}

function CommitmentsPanel({
  jobs,
  engagement,
  onOpen,
}: {
  jobs: DecisionJob[];
  engagement: Record<string, EngagementState>;
  onOpen: (job: DecisionJob) => void;
}) {
  return (
    <>
      <div className="panel-heading">
        <BriefcaseBusiness />
        <div>
          <h1>我的跟进</h1>
          <p>关注中、跟进中和需要继续处理的职位</p>
        </div>
      </div>
      <div className="mobile-commitment-list">
        {jobs.length ? (
          jobs.map((job) => (
            <button key={job.id} onClick={() => onOpen(job)}>
              <span>
                <b>
                  {job.company} · {job.role}
                </b>
                <small>
                  {engagement[job.id] === "ACCEPTED"
                    ? "跟进中 · 推进行动或记录结果"
                    : "关注中 · 评估后开始跟进或取消关注"}
                </small>
              </span>
              <ChevronRight />
            </button>
          ))
        ) : (
          <p>暂无跟进职位。</p>
        )}
      </div>
    </>
  );
}


export { WorkbenchPanel };
