import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  BrainxApiError,
  brainxFetch,
  connectSSE,
  fetchJobDetail,
  getClients,
  getRadar,
  getSnapshot,
  type BackendClientRow,
  type BackendSessionStatus,
  type BrainxSnapshot,
  type OpenmaiResult,
  type RadarPayload,
} from "./brainx-api";
import { getRecommendationPage } from "./brainx-recommendation-pages-api";
import type { ProjectSummary } from "./brainx-projects-api";
import {
  type AuthStatus,
  type DecisionEvent,
  type EngagementState,
  type Notification,
  type Outcome,
  type SyncStatus,
} from "./decision-demo";
import { DEFAULT_FOLDERS, type DecisionJob, type MembershipRelation, type PickFolder } from "./workbench-model";
import type { useRecommendationPages } from "./use-recommendation-pages";
import type { WorkspaceEntryKind } from "./workbench-entry";

type Mode = "connecting" | "connected" | "offline";

type RecommendationQueue = ReturnType<typeof useRecommendationPages>;

interface WorkbenchConnectionArgs {
  demo: boolean;
  hydrated: boolean;
  recommendationQueue: RecommendationQueue;
  setBrainxJobs: Dispatch<SetStateAction<DecisionJob[] | null>>;
  setBrainxProjects: Dispatch<SetStateAction<ProjectSummary[]>>;
  setMembershipRelations: Dispatch<SetStateAction<Record<string, MembershipRelation>>>;
  setBrainxConsultantId: Dispatch<SetStateAction<string>>;
  setEngagement: Dispatch<SetStateAction<Record<string, EngagementState>>>;
  setOpenmaiByJob: Dispatch<SetStateAction<Record<string, OpenmaiResult | null>>>;
  setDecisionEvents: Dispatch<SetStateAction<Record<string, DecisionEvent[]>>>;
  setOutcomes: Dispatch<SetStateAction<Record<string, Outcome[]>>>;
  setSync: Dispatch<SetStateAction<SyncStatus>>;
  setAuth: Dispatch<SetStateAction<AuthStatus>>;
  setNotifications: Dispatch<SetStateAction<Notification[]>>;
  setBrainxDismissReasons: Dispatch<SetStateAction<string[]>>;
  setBrainxRun: Dispatch<
    SetStateAction<{ runId: string | null; snapshotId: string | null; policyVersion: string | null }>
  >;
  setBrainxKeywords: Dispatch<SetStateAction<string[]>>;
  setTray: Dispatch<SetStateAction<string[]>>;
  setFolders: Dispatch<SetStateAction<PickFolder[]>>;
  setFolderMode: Dispatch<SetStateAction<boolean>>;
  setBrainxRadar: Dispatch<SetStateAction<RadarPayload | null>>;
  setBrainxClients: Dispatch<SetStateAction<BackendClientRow[] | null>>;
}

// BrainX 后端连接态：connecting（探测中）→ connected（API 驱动）/ offline（真实数据不可用）；演示数据仅由 demo 属性显式开启。
// 快照加载、连接探测与 SSE 实时通知，从工作台主组件原样搬出。
export function useWorkbenchConnection({
  demo,
  hydrated,
  recommendationQueue,
  setBrainxJobs,
  setBrainxProjects,
  setMembershipRelations,
  setBrainxConsultantId,
  setEngagement,
  setOpenmaiByJob,
  setDecisionEvents,
  setOutcomes,
  setSync,
  setAuth,
  setNotifications,
  setBrainxDismissReasons,
  setBrainxRun,
  setBrainxKeywords,
  setTray,
  setFolders,
  setFolderMode,
  setBrainxRadar,
  setBrainxClients,
}: WorkbenchConnectionArgs) {
  const [brainxMode, setBrainxMode] = useState<Mode>(demo ? "offline" : "connecting");
  const [workspaceIssue, setWorkspaceIssue] = useState<Exclude<WorkspaceEntryKind, "connecting"> | null>(
    null,
  );
  const [connectAttempt, setConnectAttempt] = useState(0);
  const loadBrainxSide = useRef(async () => {
    await Promise.allSettled([
      getRadar().then((radar) => setBrainxRadar(radar)),
      getClients().then((clientsData) => setBrainxClients(clientsData.items)),
    ]);
  });
  const brainxApply = useRef((snapshot: BrainxSnapshot) => {
    setBrainxJobs(snapshot.jobs as DecisionJob[]);
    setBrainxProjects(snapshot.projects);
    setMembershipRelations(
      Object.fromEntries(snapshot.projects.map((project) => [project.project_id, project.relation])),
    );
    setBrainxConsultantId(snapshot.consultantId);
    setEngagement(snapshot.engagement);
    setOpenmaiByJob(snapshot.openmai || {});
    setDecisionEvents(snapshot.events);
    setOutcomes(snapshot.outcomes);
    setSync(snapshot.sync);
    setAuth(snapshot.auth);
    setNotifications(snapshot.notifications);
    setBrainxDismissReasons(snapshot.dismissReasons);
    setBrainxRun({
      runId: snapshot.runId,
      snapshotId: snapshot.snapshotId,
      policyVersion: snapshot.policyVersion,
    });
    setBrainxKeywords(snapshot.profileKeywords);
    setTray(snapshot.preferences.tray);
    setFolders(snapshot.preferences.folders.length ? snapshot.preferences.folders : DEFAULT_FOLDERS);
    setFolderMode(!!snapshot.preferences.folderMode);
    setBrainxMode("connected");
  });
  const loadBrainxSnapshot = useRef(async () => {
    const [snapshot, page] = await Promise.all([getSnapshot(), getRecommendationPage().catch(() => null)]);
    brainxApply.current(snapshot);
    if (page) {
      recommendationQueue.reset(page);
    }
  });
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ jobId: string; state: EngagementState }>).detail;
      if (detail?.jobId && detail?.state)
        setEngagement((current) => ({ ...current, [detail.jobId]: detail.state }));
    };
    window.addEventListener("brainx:commitment-updated", update);
    return () => window.removeEventListener("brainx:commitment-updated", update);
  }, []);
  // 连接探测只保留异步回调里的状态迁移；重试时的 connecting 复位走 retryConnection 事件处理
  useEffect(() => {
    if (!hydrated || demo) return;
    let cancelled = false;
    void (async () => {
      try {
        await brainxFetch<BackendSessionStatus>("/api/v1/oauth/status");
        await loadBrainxSnapshot.current();
        if (cancelled) return;
        void loadBrainxSide.current();
      } catch (error) {
        if (cancelled) return;
        setBrainxMode("offline");
        setWorkspaceIssue(error instanceof BrainxApiError && error.kind === "AUTH" ? "auth" : "unavailable");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated, demo, connectAttempt]);
  // 用户点击重试：先复位到 connecting 再触发新一轮探测（事件处理器里允许同步 setState）
  const retryConnection = () => {
    setBrainxMode("connecting");
    setWorkspaceIssue(null);
    setConnectAttempt((value) => value + 1);
  };
  // SSE 实时通知：同步/推荐事件 → 去抖刷新快照并插入提醒；组件卸载关闭连接
  useEffect(() => {
    if (brainxMode !== "connected") return;
    const sub = connectSSE((event) => {
      if (!event.type || event.type === "hello") return;
      if (event.type === "openmai_result") {
        const pid = String((event as { project_id?: string }).project_id || "");
        setNotifications((current) => [
          {
            id: `sse-om-${Date.now()}`,
            kind: "SYNC_ALERT",
            title: (event as { status?: string }).status === "done" ? "自动找人完成" : "自动找人失败",
            detail: pid,
            read: false,
          },
          ...current,
        ]);
        if (pid)
          window.setTimeout(() => {
            void fetchJobDetail(pid)
              .then((d) => setOpenmaiByJob((current) => ({ ...current, [pid]: d.openmai })))
              .catch(() => {});
          }, 600);
        return;
      }
      const title =
        event.type === "sync_error" ? "同步异常" : event.type === "recommend" ? "推荐已更新" : "同步完成";
      setNotifications((current) => [
        {
          id: `sse-${Date.now()}`,
          kind: "SYNC_ALERT",
          title,
          detail: String(event.message || ""),
          read: false,
        },
        ...current,
      ]);
      if (event.type === "recommend") {
        recommendationQueue.markNewRun();
        return;
      }
      window.setTimeout(() => {
        void loadBrainxSnapshot.current().catch(() => {});
        void loadBrainxSide.current();
      }, 800);
    });
    return () => sub.close();
  }, [brainxMode]);
  return { brainxMode, workspaceIssue, retryConnection, loadBrainxSnapshot, loadBrainxSide };
}
