import type { Dispatch, SetStateAction } from "react";
import {
  brainxFetch,
  makeIdempotencyKey,
  type BackendEngagementResponse,
  type BackendOutcomeResponse,
  type BackendRecommendationRun,
} from "./brainx-api";
import {
  seedSync,
  type DecisionEvent,
  type EngagementCommand,
  type EngagementState,
  type Notification,
  type Outcome,
  type SyncStatus,
} from "./decision-demo";
import { nextState, stateEvent, type DecisionAction, type DecisionJob, type Panel } from "./workbench-model";
import type { PendingCommand } from "./use-workbench-panel";
import type { NotifyFn } from "./workbench-toast";
import type { RefreshBrainxJob } from "./use-workbench-actions";

type Mode = "connecting" | "connected" | "offline";

interface WorkbenchEngagementArgs {
  brainxMode: Mode;
  notify: NotifyFn;
  refreshBrainxJob: RefreshBrainxJob;
  loadBrainxSnapshot: { current: () => Promise<void> };
  loadBrainxSide: { current: () => Promise<void> };
  setEngagement: Dispatch<SetStateAction<Record<string, EngagementState>>>;
  setDecisionEvents: Dispatch<SetStateAction<Record<string, DecisionEvent[]>>>;
  setOutcomes: Dispatch<SetStateAction<Record<string, Outcome[]>>>;
  setPendingCommand: Dispatch<SetStateAction<PendingCommand>>;
  setSync: Dispatch<SetStateAction<SyncStatus>>;
  setNotifications: Dispatch<SetStateAction<Notification[]>>;
  decisionActions: string[];
  setDecisionActions: Dispatch<SetStateAction<string[]>>;
  activeDecisionJobs: DecisionJob[];
  openDecision: (job: DecisionJob, tab?: "facts" | "judgement" | "engagement" | "trail" | "replay") => void;
  openPanel: (panel: Panel) => void;
}

// 承接状态机指令、终局结果记录、手动同步与动作打点，从工作台主组件原样搬出。
export function useWorkbenchEngagement({
  brainxMode,
  notify,
  refreshBrainxJob,
  loadBrainxSnapshot,
  loadBrainxSide,
  setEngagement,
  setDecisionEvents,
  setOutcomes,
  setPendingCommand,
  setSync,
  setNotifications,
  decisionActions,
  setDecisionActions,
  activeDecisionJobs,
  openDecision,
  openPanel,
}: WorkbenchEngagementArgs) {
  const applyCommand = (job: DecisionJob, command: EngagementCommand, reason?: string) => {
    if (brainxMode !== "connected") {
      const state = nextState(command);
      setEngagement((current) => ({ ...current, [job.id]: state }));
      setDecisionEvents((current) => ({
        ...current,
        [job.id]: [
          {
            id: `evt-${Date.now()}`,
            type: stateEvent(command),
            at: new Date().toLocaleString("zh-CN", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            }),
            reason,
          },
          ...(current[job.id] || []),
        ],
      }));
      setPendingCommand(null);
      notify(`${job.company} · ${stateEvent(command)}`);
      return;
    }
    const key = makeIdempotencyKey(`engage:${job.id}:${command}`);
    setPendingCommand(null);
    void (async () => {
      try {
        const res = await brainxFetch<BackendEngagementResponse>(
          `/api/v1/opportunities/${encodeURIComponent(job.id)}/engagement`,
          {
            method: "POST",
            body: { action: command, confirm: command === "ACCEPT", reason, idempotency_key: key },
          },
        );
        setEngagement((current) => ({ ...current, [job.id]: res.state }));
        await refreshBrainxJob(job.id);
        notify(`${job.company} · ${stateEvent(command)}`);
      } catch (error) {
        notify(`操作失败：${error instanceof Error ? error.message : "后端未响应"}`);
      }
    })();
  };
  const requestCommand = (job: DecisionJob, command: EngagementCommand) => {
    if (command === "ACCEPT" || command === "DISMISS") {
      setPendingCommand({ job, command });
      return;
    }
    applyCommand(job, command);
  };
  const recordOutcome = (job: DecisionJob, stage: Outcome["stage"], rating?: number, note?: string) => {
    if (brainxMode !== "connected") {
      const item: Outcome = {
        id: `out-${Date.now()}`,
        stage,
        rating,
        note,
        at: new Date().toLocaleString("zh-CN", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
      };
      setOutcomes((current) => ({ ...current, [job.id]: [item, ...(current[job.id] || [])] }));
      setDecisionEvents((current) => ({
        ...current,
        [job.id]: [
          { id: `evt-${Date.now()}`, type: "记录结果", at: item.at, reason: stage },
          ...(current[job.id] || []),
        ],
      }));
      notify(`已记录${stage}`);
      return;
    }
    void (async () => {
      try {
        await brainxFetch<BackendOutcomeResponse>("/api/v1/outcomes", {
          method: "POST",
          body: {
            project_id: job.id,
            stage,
            value: { rating, note },
            idempotency_key: makeIdempotencyKey(`outcome:${job.id}`),
          },
        });
        await refreshBrainxJob(job.id);
        notify(`已记录${stage}`);
      } catch (error) {
        notify(`记录失败：${error instanceof Error ? error.message : "后端未响应"}`);
      }
    })();
  };
  const runSync = () => {
    void (async () => {
      if (brainxMode !== "connected") {
        setSync((current) => ({ ...current, state: "RUNNING", errors: [] }));
        notify("正在生成演示快照…");
        window.setTimeout(() => {
          setSync({
            ...seedSync,
            updatedAt: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
          });
          notify("快照已更新，推荐已刷新");
        }, 650);
        return;
      }
      setSync((current) => ({ ...current, state: "RUNNING", errors: [] }));
      notify("正在同步后端快照…");
      try {
        await brainxFetch("/api/v1/sync-runs", { method: "POST", body: { source: "fixture" } });
        const rec = await brainxFetch<BackendRecommendationRun>("/api/v1/recommendations/run", {
          method: "POST",
        });
        if (rec?.blocked) {
          setSync((current) => ({
            ...current,
            state: "INCOMPLETE",
            errors: [rec.reason || "本次同步不完整"],
          }));
          notify(rec.reason || "本次同步不完整");
          return;
        }
        await loadBrainxSnapshot.current();
        void loadBrainxSide.current();
        notify("快照已更新，推荐已刷新");
      } catch (error) {
        setSync((current) => ({
          ...current,
          state: "ERROR",
          errors: [error instanceof Error ? error.message : "同步失败"],
        }));
        notify(`同步失败：${error instanceof Error ? error.message : "后端未响应"}`);
      }
    })();
  };
  const runDecisionAction = (job: DecisionJob, action: DecisionAction) => {
    const key = `${job.id}:${action.id}`;
    if (decisionActions.includes(key)) return;
    const at = new Date().toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    setDecisionActions((v) => [...v, key]);
    setDecisionEvents((current) => ({
      ...current,
      [job.id]: [
        { id: `evt-${Date.now()}`, type: action.label, at, reason: action.detail },
        ...(current[job.id] || []),
      ],
    }));
    if (action.kind === "verify")
      window.dispatchEvent(new CustomEvent("brainx:edit-facts", { detail: job.id }));
    notify(`已记录：${action.label}`);
  };
  const openNotification = (item: Notification) => {
    setNotifications((current) =>
      current.map((note) => (note.id === item.id ? { ...note, read: true } : note)),
    );
    if (item.jobId) {
      const job = activeDecisionJobs.find((entry) => entry.id === item.jobId);
      if (job) openDecision(job, item.kind === "DAILY_TOP3" ? "judgement" : "engagement");
    } else openPanel({ kind: "sync" });
  };
  return { applyCommand, requestCommand, recordOutcome, runSync, runDecisionAction, openNotification };
}
