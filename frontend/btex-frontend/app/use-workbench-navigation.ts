import { useMemo, type Dispatch, type SetStateAction } from "react";
import { brainxFetch, makeIdempotencyKey, type BackendEngagementResponse } from "./brainx-api";
import { projectToDecisionJob, type ProjectSummary } from "./brainx-projects-api";
import type { EngagementState, SyncStatus } from "./decision-demo";
import type { JobDetailTab } from "./job-detail-card-review";
import type { BrainxRun, RefreshBrainxJob } from "./use-workbench-actions";
import type { PanelMotion } from "./use-workbench-panel";
import type { useRecommendationPages } from "./use-recommendation-pages";
import {
  decisionJobs,
  verificationJobs,
  type DecisionJob,
  type MembershipRelation,
  type Page,
  type Panel,
} from "./workbench-model";
import type { WorkspaceShellPage } from "./workspace-shell";

type Mode = "connecting" | "connected" | "offline";

type RecommendationQueue = ReturnType<typeof useRecommendationPages>;

interface WorkbenchNavigationArgs {
  demo: boolean;
  page: Page;
  brainxMode: Mode;
  brainxJobs: DecisionJob[] | null;
  brainxProjects: ProjectSummary[];
  membershipRelations: Record<string, MembershipRelation>;
  engagement: Record<string, EngagementState>;
  brainxRun: BrainxRun;
  sync: SyncStatus;
  recommendationQueue: RecommendationQueue;
  setPage: Dispatch<SetStateAction<Page>>;
  panel: Panel;
  panelMotion: PanelMotion;
  openPanel: (panel: Panel) => void;
  closePanel: () => void;
  dismissPanelImmediately: () => void;
  refreshBrainxJob: RefreshBrainxJob;
}

// 页面导航、职位详情开合与推荐队列/项目列表的派生数据，从工作台主组件原样搬出。
export function useWorkbenchNavigation({
  demo,
  page,
  brainxMode,
  brainxJobs,
  brainxProjects,
  membershipRelations,
  engagement,
  brainxRun,
  sync,
  recommendationQueue,
  setPage,
  panel,
  panelMotion,
  openPanel,
  closePanel,
  dismissPanelImmediately,
  refreshBrainxJob,
}: WorkbenchNavigationArgs) {
  const go = (p: Page) => {
    setPage(p);
    dismissPanelImmediately();
  };
  const openDecision = (job: DecisionJob, tab: JobDetailTab = "facts") => {
    if (panel?.kind === "job" && panel.jobId === job.id && panel.tab === tab && panelMotion !== "closing") {
      closePanel();
      return;
    }
    if (brainxMode === "connected") {
      void refreshBrainxJob(job.id);
      void brainxFetch<BackendEngagementResponse>(
        `/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`,
        { method: "POST", body: { action: "VIEW", idempotency_key: makeIdempotencyKey(`view:${job.id}`) } },
      ).catch(() => {});
    }
    openPanel({ kind: "job", jobId: job.id, tab });
  };
  const activeDecisionJobs = useMemo(
    () =>
      (brainxJobs ?? (demo ? decisionJobs : [])).map((job) => {
        const relation = membershipRelations[job.id];
        if (!relation) return job;
        return { ...job, facts: { ...job.facts, 职位关系: relation === "MY_JOB" ? "我的职位" : "团队共享" } };
      }),
    [brainxJobs, demo, membershipRelations],
  );
  const projectDecisionJobs = useMemo(() => brainxProjects.map(projectToDecisionJob), [brainxProjects]);
  const allDecisionJobs = useMemo(
    () => [
      ...activeDecisionJobs,
      ...projectDecisionJobs.filter((project) => !activeDecisionJobs.some((job) => job.id === project.id)),
    ],
    [activeDecisionJobs, projectDecisionJobs],
  );
  const selectedDecisionJob =
    panel?.kind === "job"
      ? [...allDecisionJobs, ...verificationJobs].find((job) => job.id === panel.jobId) || null
      : null;
  const commitmentJobs = allDecisionJobs.filter((job) =>
    ["WATCHED", "ACCEPTED"].includes(engagement[job.id] || "NEW"),
  );
  const shellPage: WorkspaceShellPage =
    page === "accepted"
      ? "projects"
      : page === "clients"
        ? "clients"
        : page === "jobs"
          ? "jobs"
          : page === "today"
            ? "today"
            : "settings";
  const recommendationPagination = demo
    ? undefined
    : {
        pageIndex: recommendationQueue.pageIndex,
        totalCount: recommendationQueue.current?.totalCount ?? activeDecisionJobs.length,
        evaluatedCount: recommendationQueue.current?.evaluatedCount ?? activeDecisionJobs.length,
        runId: recommendationQueue.current?.runId || brainxRun.runId || "",
        generatedAt: recommendationQueue.current?.generatedAt || sync.updatedAt || "时间待确认",
        policyVersion: recommendationQueue.current?.policyVersion || brainxRun.policyVersion || "待确认",
        loading: recommendationQueue.loading,
        error: recommendationQueue.error,
        newRunAvailable: recommendationQueue.current?.newRunAvailable ?? false,
        onPrevious: recommendationQueue.previous,
        onNext: recommendationQueue.next,
        onRefreshRun: recommendationQueue.refresh,
      };
  return {
    go,
    openDecision,
    activeDecisionJobs,
    allDecisionJobs,
    selectedDecisionJob,
    commitmentJobs,
    shellPage,
    recommendationPagination,
  };
}
