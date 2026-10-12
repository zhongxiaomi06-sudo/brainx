import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { updateWorkbenchPreferences } from "./brainx-api";
import {
  seedAuth,
  seedNotifications,
  seedSync,
  type AuthStatus,
  type DecisionEvent,
  type EngagementState,
  type Notification,
  type Outcome,
  type SyncStatus,
} from "./decision-demo";
import {
  DEFAULT_FOLDERS,
  INITIAL_TRAY_IDS,
  initialEngagement,
  initialEvents,
  initialOutcomes,
  readSavedWorkbenchState,
  type MembershipRelation,
  type PickFolder,
} from "./workbench-model";

type Mode = "connecting" | "connected" | "offline";

interface WorkbenchHydrationArgs {
  setDecisionActions: Dispatch<SetStateAction<string[]>>;
  setMembershipRelations: Dispatch<SetStateAction<Record<string, MembershipRelation>>>;
  setTray: Dispatch<SetStateAction<string[]>>;
  setFolders: Dispatch<SetStateAction<PickFolder[]>>;
  setFolderMode: Dispatch<SetStateAction<boolean>>;
  setEngagement: Dispatch<SetStateAction<Record<string, EngagementState>>>;
  setDecisionEvents: Dispatch<SetStateAction<Record<string, DecisionEvent[]>>>;
  setOutcomes: Dispatch<SetStateAction<Record<string, Outcome[]>>>;
  setSync: Dispatch<SetStateAction<SyncStatus>>;
  setAuth: Dispatch<SetStateAction<AuthStatus>>;
  setNotifications: Dispatch<SetStateAction<Notification[]>>;
}

interface WorkbenchPersistArgs {
  hydrated: boolean;
  brainxMode: Mode;
  tray: string[];
  folders: PickFolder[];
  folderMode: boolean;
  decisionActions: string[];
  membershipRelations: Record<string, MembershipRelation>;
  engagement: Record<string, EngagementState>;
  decisionEvents: Record<string, DecisionEvent[]>;
  outcomes: Record<string, Outcome[]>;
  sync: SyncStatus;
  auth: AuthStatus;
  notifications: Notification[];
}

// 本地演示态的 hydration 与 localStorage 持久化（连接后端后改为写偏好接口），从工作台主组件原样搬出。
// 拆成两个 hook 是因为 persist 依赖连接态（connection hook 又依赖 hydration 的 hydrated）。
export function useWorkbenchHydration({
  setDecisionActions,
  setMembershipRelations,
  setTray,
  setFolders,
  setFolderMode,
  setEngagement,
  setDecisionEvents,
  setOutcomes,
  setSync,
  setAuth,
  setNotifications,
}: WorkbenchHydrationArgs) {
  const [hydrated, setHydrated] = useState(false);
  const [done, setDone] = useState<number[]>([]);
  const [snoozed, setSnoozed] = useState<number[]>([]);
  const [extraTasks, setExtraTasks] = useState<string[]>([]);
  const [weights, setWeights] = useState([60, 25, 15]);
  // SSR 首帧必须用默认值（避免水合不一致），本地快照在挂载后经宏任务读回，避免在 effect 里同步级联渲染
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const savedState = readSavedWorkbenchState();
      setDone(savedState.done || []);
      setSnoozed(savedState.snoozed || []);
      setExtraTasks(savedState.extraTasks || []);
      setWeights(savedState.weights?.length === 3 ? savedState.weights : [60, 25, 15]);
      setDecisionActions(savedState.decisionActions || []);
      setMembershipRelations(savedState.membershipRelations || {});
      setTray(savedState.tray ?? INITIAL_TRAY_IDS);
      setFolders(savedState.folders?.length ? savedState.folders : DEFAULT_FOLDERS);
      setFolderMode(!!savedState.folderMode);
      setEngagement({ ...initialEngagement, ...(savedState.engagement || {}) });
      setDecisionEvents({ ...initialEvents, ...(savedState.events || {}) });
      setOutcomes({ ...initialOutcomes, ...(savedState.outcomes || {}) });
      setSync(savedState.sync || seedSync);
      setAuth(savedState.auth || seedAuth);
      setNotifications(savedState.notifications || seedNotifications);
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  return { hydrated, done, snoozed, extraTasks, weights };
}

export function useWorkbenchPersist({
  hydrated,
  brainxMode,
  tray,
  folders,
  folderMode,
  decisionActions,
  membershipRelations,
  engagement,
  decisionEvents,
  outcomes,
  sync,
  auth,
  notifications,
  done,
  snoozed,
  extraTasks,
  weights,
}: WorkbenchPersistArgs & {
  done: number[];
  snoozed: number[];
  extraTasks: string[];
  weights: number[];
}) {
  useEffect(() => {
    if (!hydrated) return;
    if (brainxMode === "connected") {
      localStorage.setItem(
        "decision-workbench",
        JSON.stringify({ tray, folders, folderMode, weights, decisionActions, membershipRelations }),
      );
      void updateWorkbenchPreferences({ tray, folders, folderMode }).catch(() => {});
      return;
    }
    localStorage.setItem(
      "decision-workbench",
      JSON.stringify({
        done,
        snoozed,
        extraTasks,
        weights,
        decisionActions,
        membershipRelations,
        tray,
        folders,
        folderMode,
        engagement,
        events: decisionEvents,
        outcomes,
        sync,
        auth,
        notifications,
      }),
    );
  }, [
    hydrated,
    brainxMode,
    done,
    snoozed,
    extraTasks,
    weights,
    decisionActions,
    membershipRelations,
    tray,
    folders,
    folderMode,
    engagement,
    decisionEvents,
    outcomes,
    sync,
    auth,
    notifications,
  ]);
}
