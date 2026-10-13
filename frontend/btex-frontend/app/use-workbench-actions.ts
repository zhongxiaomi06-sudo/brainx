import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  fetchJobDetail,
  makeIdempotencyKey,
  rerunOpenmai,
  sendRecommendationFeedback,
  undoRecommendationFeedback,
  type OpenmaiResult,
  type RadarPayload,
} from "./brainx-api";
import {
  getProjects,
  launchProjectWorkflow,
  projectLaunchNotice,
  updateOpportunityMembership,
  type ProjectSummary,
} from "./brainx-projects-api";
import {
  type DecisionEvent,
  type EngagementState,
  type Outcome,
} from "./decision-demo";
import { DEFAULT_FOLDERS, type DecisionJob, type MembershipRelation, type Page, type PickFolder } from "./workbench-model";
import { createProjectIgnore } from "./project-ignore-action";
import type { useRecommendationPages } from "./use-recommendation-pages";
import type { NotifyFn } from "./workbench-toast";

type Mode = "connecting" | "connected" | "offline";

export type BrainxRun = {
  runId: string | null; snapshotId: string | null; policyVersion: string | null;
  engine: "baseline-1.1" | "agentic-ranking-v1";
};

type RecommendationQueue = ReturnType<typeof useRecommendationPages>;

export type RefreshBrainxJob = (jobId: string, withProjects?: boolean) => Promise<void>;

// 收藏托盘与文件夹：纯本地 UI 状态与操作，从工作台主组件原样搬出。
export function useWorkbenchTray({ notify }: { notify: NotifyFn }) {
  const [tray, setTray] = useState<string[]>([]);
  const [folders, setFolders] = useState<PickFolder[]>(DEFAULT_FOLDERS);
  const [folderMode, setFolderMode] = useState(false);
  const toggleTray = (id: string) => {
    setTray((current) => {
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      notify(next.includes(id) ? "已收藏职位" : "已移出收藏");
      return next;
    });
  };
  const removeTray = (id: string) => {
    setTray((current) => current.filter((x) => x !== id));
    notify("已移出收藏");
  };
  const assignFolder = (jobId: string, folderId: string) => {
    setFolders((current) =>
      current.map((f) =>
        f.id === folderId
          ? { ...f, jobIds: Array.from(new Set([...f.jobIds, jobId])) }
          : { ...f, jobIds: f.jobIds.filter((x) => x !== jobId) },
      ),
    );
    setTray((current) => current.filter((x) => x !== jobId));
    notify(folderId ? "已放入文件夹" : "已从文件夹移除");
  };
  const createFolder = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setFolders((current) => [...current, { id: `f-${Date.now()}`, name: trimmed, jobIds: [] }]);
    notify(`已新建文件夹「${trimmed}」`);
  };
  return {
    tray,
    setTray,
    folders,
    setFolders,
    folderMode,
    setFolderMode,
    toggleTray,
    removeTray,
    assignFolder,
    createFolder,
  };
}

interface WorkbenchFeedbackArgs {
  brainxMode: Mode;
  brainxJobs: DecisionJob[] | null;
  brainxRun: BrainxRun;
  recommendationQueue: RecommendationQueue;
  notify: NotifyFn;
  setBrainxJobs: Dispatch<SetStateAction<DecisionJob[] | null>>;
  setOpenmaiByJob: Dispatch<SetStateAction<Record<string, OpenmaiResult | null>>>;
  setEngagement: Dispatch<SetStateAction<Record<string, EngagementState>>>;
  setDecisionEvents: Dispatch<SetStateAction<Record<string, DecisionEvent[]>>>;
  setOutcomes: Dispatch<SetStateAction<Record<string, Outcome[]>>>;
  setBrainxProjects: Dispatch<SetStateAction<ProjectSummary[]>>;
  setMembershipRelations: Dispatch<SetStateAction<Record<string, MembershipRelation>>>;
}

// 推荐反馈（不感兴趣/撤销）、OpenMai 重跑与单职位详情刷新，从工作台主组件原样搬出。
export function useWorkbenchFeedback({
  brainxMode,
  brainxJobs,
  brainxRun,
  recommendationQueue,
  notify,
  setBrainxJobs,
  setOpenmaiByJob,
  setEngagement,
  setDecisionEvents,
  setOutcomes,
  setBrainxProjects,
  setMembershipRelations,
}: WorkbenchFeedbackArgs) {
  const feedbackJob = (job: DecisionJob) => {
    const doDelete = async (reason: string) => {
      const clean = (reason || "").trim().slice(0, 200);
      const snapshot = brainxJobs;
      const pageSnapshot = { pages: recommendationQueue.pages, pageIndex: recommendationQueue.pageIndex };
      try {
        if (brainxMode === "connected") {
          await sendRecommendationFeedback(
            job.id,
            job.brainxDecisionId || null,
            clean,
            brainxRun.snapshotId,
            makeIdempotencyKey(`recommendation-feedback:${job.id}`),
          );
        }
        setBrainxJobs((current) => (current ? current.filter((item) => item.id !== job.id) : current));
        recommendationQueue.removeJob(job.id);
        notify(brainxMode === "connected" ? "已减少此类推荐" : "演示模式已隐藏该职位（不会写入后端）", {
          actions: [
            {
              label: "撤销",
              onClick: () => {
                setBrainxJobs(snapshot);
                recommendationQueue.restore(pageSnapshot);
                if (brainxMode === "connected")
                  void undoRecommendationFeedback(job.id, job.brainxDecisionId || null,
                    makeIdempotencyKey(`recommendation-feedback-undo:${job.id}`))
                    .then(() => notify("已撤销不感兴趣"))
                    .catch((error) =>
                      notify(
                        `撤销已恢复本地显示，但后端删除失败：${error instanceof Error ? error.message : "后端未响应"}`,
                        undefined,
                        4000,
                      ),
                    );
                if (brainxMode !== "connected") notify("已撤销不感兴趣");
              },
            },
          ],
        });
      } catch (error) {
        notify(`反馈失败：${error instanceof Error ? error.message : "后端未响应"}`);
      }
    };
    notify(`为什么删除「${job.company} · ${job.role}」？（必填）`, {
      input: {
        placeholder: "例如：方向不符 / 客户质量不足 / 当前没精力…",
        onSubmit: (text) => {
          void doDelete(text);
        },
      },
    });
  };
  const refreshBrainxJob = async (jobId: string, withProjects = false) => {
    if (brainxMode !== "connected") return;
    try {
      const [detail, projects] = await Promise.all([
        fetchJobDetail(jobId),
        withProjects ? getProjects() : Promise.resolve(null),
      ]);
      setEngagement((current) => ({ ...current, [jobId]: detail.engagementState }));
      setDecisionEvents((current) => ({ ...current, [jobId]: detail.events }));
      setOutcomes((current) => ({ ...current, [jobId]: detail.outcomes }));
      setOpenmaiByJob((current) => ({ ...current, [jobId]: detail.openmai }));
      setBrainxJobs((current) =>
        current
          ? current.map((job) =>
              job.id === jobId
                ? {
                    ...job,
                    brainxLegal: detail.legal,
                    brainxDecisionId: detail.decisionId || job.brainxDecisionId,
                  }
                : job,
            )
          : null,
      );
      if (projects) {
        setBrainxProjects(projects.items);
        setMembershipRelations(
          Object.fromEntries(projects.items.map((project) => [project.project_id, project.relation])),
        );
      }
    } catch {
      /* 详情刷新失败不打断交互，下次打开再试 */
    }
  };
  const rerunOpenmaiForJob = (jobId: string, searchBrief = "") => {
    void (async () => {
      try {
        await rerunOpenmai(jobId, searchBrief);
        const detail = await fetchJobDetail(jobId);
        setOpenmaiByJob((current) => ({ ...current, [jobId]: detail.openmai }));
      } catch (error) {
        notify(`重新找人失败：${error instanceof Error ? error.message : "后端未响应"}`);
      }
    })();
  };
  return { feedbackJob, refreshBrainxJob, rerunOpenmaiForJob };
}

interface WorkbenchProjectsArgs {
  brainxMode: Mode;
  brainxRadar: RadarPayload | null;
  setBrainxProjects: Dispatch<SetStateAction<ProjectSummary[]>>;
  setMembershipRelations: Dispatch<SetStateAction<Record<string, MembershipRelation>>>;
  go: (page: Page) => void;
  notify: NotifyFn;
  refreshBrainxJob: RefreshBrainxJob;
}

// 我的项目：关注/接单/忽略与飞书项目群拉起，从工作台主组件原样搬出。
export function useWorkbenchProjects({
  brainxMode,
  brainxRadar,
  setBrainxProjects,
  setMembershipRelations,
  go,
  notify,
  refreshBrainxJob,
}: WorkbenchProjectsArgs) {
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const joiningProjects = useRef(new Set<string>());
  const goToProject = (projectId: string) => {
    setFocusedProjectId(projectId);
    go("accepted");
  };
  const refreshProjects = async () => {
    const response = await getProjects();
    setBrainxProjects(response.items);
    setMembershipRelations(
      Object.fromEntries(response.items.map((project) => [project.project_id, project.relation])),
    );
  };
  const launchProjectInFeishu = async (project: Pick<ProjectSummary, "project_id" | "company">) => {
    if (brainxMode !== "connected") throw new Error("BrainTex 服务当前不可用，请恢复连接后重试");
    const response = await launchProjectWorkflow(
      project.project_id,
      makeIdempotencyKey(`project-launch:${project.project_id}`),
    );
    await Promise.all([refreshProjects(), refreshBrainxJob(project.project_id)]);
    notify(projectLaunchNotice(project.company, response.search.status));
  };
  const mergeProject = (project: ProjectSummary | null) => {
    if (!project) return;
    setBrainxProjects((current) => [
      project,
      ...current.filter((item) => item.project_id !== project.project_id),
    ]);
    setMembershipRelations((current) => ({ ...current, [project.project_id]: project.relation }));
  };
  const addToMyProjects = async (jobId: string, label = "该职位") => {
    if (joiningProjects.current.has(jobId)) return;
    joiningProjects.current.add(jobId);
    try {
      if (brainxMode === "connected") {
        const response = await updateOpportunityMembership(
          jobId,
          "MY_JOB",
          makeIdempotencyKey(`membership:${jobId}`),
        );
        mergeProject(response.project);
      } else setMembershipRelations((current) => ({ ...current, [jobId]: "MY_JOB" }));
      notify(`${label} · 已加入我的项目`, {
        actions: [
          { label: "继续浏览", onClick: () => {} },
          { label: "去我的项目", onClick: () => goToProject(jobId) },
        ],
      });
    } catch (error) {
      notify(`加入项目失败：${error instanceof Error ? error.message : "后端未响应"}`, undefined, 4000);
      throw error;
    } finally {
      joiningProjects.current.delete(jobId);
    }
  };
  const confirmJobMembership = async (job: DecisionJob, relation: MembershipRelation) => {
    if (relation === "MY_JOB") {
      await addToMyProjects(job.id, job.company);
      return;
    }
    if (brainxMode === "connected") {
      await updateOpportunityMembership(job.id, relation, makeIdempotencyKey(`membership:${job.id}`));
      await refreshProjects();
    } else setMembershipRelations((current) => ({ ...current, [job.id]: relation }));
    notify(`${job.company} · 已加入团队共享`);
  };
  // T1：详情页一键接单——入项目后立即拉起飞书群并推职位卡，全程无表单、无二次确认。
  const acceptJobAndLaunch = async (job: DecisionJob) => {
    await confirmJobMembership(job, "MY_JOB");
    await launchProjectInFeishu({ project_id: job.id, company: job.company });
  };
  const addRadarJobToProjects = async (jobId: string) => {
    const job = brainxRadar?.items.find((item) => item.project_id === jobId);
    await addToMyProjects(jobId, job?.company || "该职位");
  };
  const ignoreProject = createProjectIgnore({
    mode: brainxMode,
    focusedProjectId,
    setFocusedProjectId,
    setProjects: setBrainxProjects,
    setMemberships: setMembershipRelations,
    notify,
  });
  return {
    focusedProjectId,
    goToProject,
    launchProjectInFeishu,
    addToMyProjects,
    confirmJobMembership,
    acceptJobAndLaunch,
    addRadarJobToProjects,
    ignoreProject,
  };
}
