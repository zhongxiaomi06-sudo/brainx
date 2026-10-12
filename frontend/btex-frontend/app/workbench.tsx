"use client";
import { useEffect, useState } from "react";
import {
  FALLBACK_DISMISS_REASONS,
  brainxFetch,
  type BackendClientRow,
  type BackendSessionStatus,
  type BrainxReplay,
  type OpenmaiResult,
  type RadarPayload,
} from "./brainx-api";
import { projectToDecisionJob, type ProjectSummary } from "./brainx-projects-api";
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
import { ProjectsView } from "./projects-view";
import { useRecommendationPages } from "./use-recommendation-pages";
import { useWorkbenchAssistant } from "./use-workbench-assistant";
import {
  useWorkbenchFeedback,
  useWorkbenchProjects,
  useWorkbenchTray,
  type BrainxRun,
} from "./use-workbench-actions";
import { useWorkbenchConnection } from "./use-workbench-connection";
import useWorkbenchDeepLink from "./use-workbench-deep-link";
import { useWorkbenchEngagement } from "./use-workbench-engagement";
import { useWorkbenchNavigation } from "./use-workbench-navigation";
import { useWorkbenchPanel, type PendingCommand } from "./use-workbench-panel";
import { useWorkbenchHydration, useWorkbenchPersist } from "./use-workbench-persistence";
import { ChatbotDrawer } from "./workbench-chatbot";
import { WorkspaceEntry } from "./workbench-entry";
import { WorkbenchClientsPage, WorkbenchJobsPage } from "./workbench-fact-pages";
import {
  initialEngagement,
  initialEvents,
  initialOutcomes,
  type DecisionJob,
  type MembershipRelation,
  type Page,
} from "./workbench-model";
import { WorkbenchPanel } from "./workbench-panel";
import { Rules } from "./workbench-rules";
import { WorkbenchSettingsPage } from "./workbench-settings-page";
import { CommandConfirm } from "./workbench-side-panels";
import Sources from "./workbench-sources";
import { useWorkbenchToast, WorkbenchToast } from "./workbench-toast";
import { TodayDecisionQueue } from "./workbench-today";
import { WorkspaceShell, type WorkspaceShellPage } from "./workspace-shell";

export default function DecisionWorkbench({ demo = false }: { demo?: boolean } = {}) {
  const [page, setPage] = useState<Page>("today");
  const [query, setQuery] = useState("");
  const [decisionActions, setDecisionActions] = useState<string[]>([]);
  const [membershipRelations, setMembershipRelations] = useState<Record<string, MembershipRelation>>({});
  const [engagement, setEngagement] = useState<Record<string, EngagementState>>(initialEngagement);
  const [decisionEvents, setDecisionEvents] = useState<Record<string, DecisionEvent[]>>(initialEvents);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome[]>>(initialOutcomes);
  const [openmaiByJob, setOpenmaiByJob] = useState<Record<string, OpenmaiResult | null>>({});
  const [sync, setSync] = useState<SyncStatus>(seedSync);
  const [auth, setAuth] = useState<AuthStatus>(seedAuth);
  const [notifications, setNotifications] = useState<Notification[]>(seedNotifications);
  const [pendingCommand, setPendingCommand] = useState<PendingCommand>(null);
  const [brainxJobs, setBrainxJobs] = useState<DecisionJob[] | null>(null);
  const [brainxConsultantId, setBrainxConsultantId] = useState("");
  const [brainxRun, setBrainxRun] = useState<BrainxRun>({
    runId: null,
    snapshotId: null,
    policyVersion: null,
    engine: "baseline-1.1",
  });
  const [brainxDismissReasons, setBrainxDismissReasons] = useState<string[]>(FALLBACK_DISMISS_REASONS);
  const [brainxReplay, setBrainxReplay] = useState<Record<string, BrainxReplay>>({});
  const [brainxKeywords, setBrainxKeywords] = useState<string[]>([]);
  const [brainxNote, setBrainxNote] = useState("");
  const [brainxRadar, setBrainxRadar] = useState<RadarPayload | null>(null);
  const [brainxClients, setBrainxClients] = useState<BackendClientRow[] | null>(null);
  const [brainxProjects, setBrainxProjects] = useState<ProjectSummary[]>([]);
  const [jobCompanyFilter, setJobCompanyFilter] = useState<string | null>(null);
  const { toast, notify, dismiss: dismissToast } = useWorkbenchToast();
  const {
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
  } = useWorkbenchTray({ notify });
  const recommendationQueue = useRecommendationPages((page) => {
    setBrainxJobs(page.jobs as DecisionJob[]);
    setEngagement((current) => ({ ...current, ...page.engagement }));
    setBrainxRun({ runId: page.runId, snapshotId: page.snapshotId, policyVersion: page.policyVersion, engine: page.engine });
  });
  const { hydrated, done, snoozed, extraTasks, weights } = useWorkbenchHydration({
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
  });
  // URL 参数 ?settings=model 进入设置页：挂载后经宏任务跳转，避免在 effect 里同步级联渲染
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (new URLSearchParams(window.location.search).get("settings") === "model") setPage("settings");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  const { brainxMode, workspaceIssue, retryConnection, loadBrainxSnapshot, loadBrainxSide } =
    useWorkbenchConnection({
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
    });
  useWorkbenchPersist({
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
  });
  const { feedbackJob, refreshBrainxJob, rerunOpenmaiForJob } = useWorkbenchFeedback({
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
  });
  const { panel, panelMotion, openPanel, closePanel, dismissPanelImmediately } =
    useWorkbenchPanel(setPendingCommand);
  const {
    go,
    openDecision,
    activeDecisionJobs,
    allDecisionJobs,
    selectedDecisionJob,
    commitmentJobs,
    shellPage,
    recommendationPagination,
  } = useWorkbenchNavigation({
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
  });
  const { applyCommand, requestCommand, recordOutcome, runSync, runDecisionAction, openNotification } =
    useWorkbenchEngagement({
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
    });
  const {
    focusedProjectId,
    goToProject,
    launchProjectInFeishu,
    addToMyProjects,
    confirmJobMembership,
    acceptJobAndLaunch,
    addRadarJobToProjects,
    ignoreProject,
  } = useWorkbenchProjects({
    brainxMode,
    brainxRadar,
    setBrainxProjects,
    setMembershipRelations,
    go,
    notify,
    refreshBrainxJob,
  });
  const {
    assistantOpen,
    setAssistantOpen,
    assistantMessages,
    setAssistantMessages,
    assistantInput,
    setAssistantInput,
    assistantBusy,
    assistantSettings,
    setAssistantSettings,
    assistantTool,
    assistantAbort,
    sendAssistant,
  } = useWorkbenchAssistant({ page, contextJobId: selectedDecisionJob?.id || null });
  useWorkbenchDeepLink({
    connected: brainxMode === "connected",
    jobs: allDecisionJobs,
    onOpen: (job, kind) => {
      setPage("today");
      openDecision(job, kind === "replay" ? "judgement" : "facts");
    },
    onCandidate: (candidateRef, jobRef) => {
      setAssistantOpen(true);
      setAssistantInput(`请分析候选人 ${candidateRef} 与职位 ${jobRef} 的匹配、证据、风险和待确认项。`);
    },
  });
  const navigateShell = (next: WorkspaceShellPage) => {
    if (next === "jobs") setJobCompanyFilter(null);
    if (next === "settings") setAssistantOpen(false);
    go(next === "projects" ? "accepted" : next === "connections" ? "sources" : next === "settings" ? "settings" : next);
  };
  return (
    <div className="btex-app formal-workbench">
      {page === "settings" ? (
        <WorkbenchSettingsPage
          auth={auth}
          consultantId={brainxConsultantId || auth.consultant}
          keywords={brainxKeywords}
          note={brainxNote}
          policyVersion={brainxRun.policyVersion}
          engine={brainxRun.engine}
          sync={sync}
          fieldReport={brainxRadar?.fieldReport ?? null}
          onBack={() => go("today")}
          onOpenConnections={() => go("sources")}
          onEditProfile={() => go("rules")}
          onRefresh={() => {
            void loadBrainxSnapshot.current();
            void loadBrainxSide.current();
            notify("正在刷新同步诊断");
          }}
          notify={notify}
        />
      ) : (
        <>
          <WorkspaceShell
            activePage={shellPage}
            onNavigate={navigateShell}
            consultant={auth.consultant}
            assistantOpen={assistantOpen}
            onAssistantToggle={() => setAssistantOpen((value) => !value)}
            assistantPlacement="overlay"
          >
            {["today", "accepted", "jobs", "clients"].includes(page) &&
            (brainxMode === "connecting" || workspaceIssue) ? (
              <WorkspaceEntry
                kind={brainxMode === "connecting" ? "connecting" : workspaceIssue!}
                onRetry={retryConnection}
                onCheckConnection={async () => {
                  await brainxFetch<BackendSessionStatus>("/api/v1/oauth/status");
                  await loadBrainxSnapshot.current();
                  await loadBrainxSide.current();
                }}
                onOpenSources={() => go("sources")}
              />
            ) : (
              <>
                {page === "today" && (
                  <TodayDecisionQueue
                    activeJobId={panel?.kind === "job" && panelMotion !== "closing" ? panel.jobId : null}
                    completed={decisionActions}
                    jobs={activeDecisionJobs}
                    projects={brainxProjects}
                    engagement={engagement}
                    sync={sync}
                    open={openDecision}
                    onAction={runDecisionAction}
                    onAddToProjects={(job) => addToMyProjects(job.id, job.company)}
                    onGoToProject={goToProject}
                    onFeedback={feedbackJob}
                    showVerification={demo}
                    tray={tray}
                    onToggleTray={toggleTray}
                    onRemoveTray={removeTray}
                    folders={folders}
                    folderMode={folderMode}
                    onFolderMode={() => setFolderMode((value) => !value)}
                    onAssignFolder={assignFolder}
                    onCreateFolder={createFolder}
                    mode={brainxMode}
                    onOpenSources={() => go("sources")}
                    pagination={
                      recommendationPagination
                        ? {
                            ...recommendationPagination,
                            searchQuery: recommendationQueue.searchQuery,
                            onSearch: recommendationQueue.search,
                            sort: recommendationQueue.sort,
                            onSort: recommendationQueue.changeSort,
                          }
                        : undefined
                    }
                  />
                )}
                {page === "accepted" && (
                  <ProjectsView
                    projects={brainxProjects}
                    query={query}
                    setQuery={setQuery}
                    focusedProjectId={focusedProjectId}
                    openDetails={(project) => openDecision(projectToDecisionJob(project), "facts")}
                    openAction={(project) => openDecision(projectToDecisionJob(project), "engagement")}
                    onLaunch={launchProjectInFeishu}
                  />
                )}
                {page === "jobs" && (
                  <WorkbenchJobsPage
                    items={brainxRadar?.items ?? []}
                    capabilities={brainxRadar?.fieldCapabilities ?? []}
                    projects={brainxProjects}
                    company={jobCompanyFilter}
                    onAddToProjects={addRadarJobToProjects}
                    onIgnoreProject={ignoreProject}
                    onOpenClient={() => go("clients")}
                    onOpenCockpit={() => go("today")}
                  />
                )}
                {page === "clients" && (
                  <WorkbenchClientsPage
                    items={brainxClients ?? []}
                    onOpenJobs={(company) => {
                      setJobCompanyFilter(company);
                      go("jobs");
                    }}
                  />
                )}
              </>
            )}
            {page === "rules" && (
              <Rules
                key={`${brainxKeywords.join("|")}:${brainxNote}`}
                notify={notify}
                mode={brainxMode}
                policy={brainxRun.policyVersion}
                engine={brainxRun.engine}
                keywords={brainxKeywords}
                note={brainxNote}
                onRefresh={async () => {
                  await loadBrainxSnapshot.current();
                  void loadBrainxSide.current();
                }}
                onProfileSaved={(nextKeywords, nextNote) => {
                  setBrainxKeywords(nextKeywords);
                  setBrainxNote(nextNote);
                }}
              />
            )}
            {page === "sources" && <Sources notify={notify} />}
          </WorkspaceShell>
          {panel && !pendingCommand && (
            <WorkbenchPanel
              panel={panel}
              motion={panelMotion}
              job={selectedDecisionJob}
              projects={brainxProjects}
              onIgnoreProject={ignoreProject}
              commitmentJobs={commitmentJobs}
              auth={auth}
              sync={sync}
              notifications={notifications}
              engagement={engagement}
              events={decisionEvents}
              outcomes={outcomes}
              completed={decisionActions}
              openmaiResults={openmaiByJob}
              onRerunOpenmai={rerunOpenmaiForJob}
              mode={brainxMode}
              legalMap={Object.fromEntries(allDecisionJobs.map((job) => [job.id, job.brainxLegal || []]))}
              replayMap={brainxReplay}
              onReplay={(jobId, data) => setBrainxReplay((current) => ({ ...current, [jobId]: data }))}
              onFactsUpdated={async () => {
                await loadBrainxSnapshot.current();
                void loadBrainxSide.current();
              }}
              onCommitmentUpdated={(jobId) => refreshBrainxJob(jobId, true)}
              onMembership={confirmJobMembership}
              onAcceptAndLaunch={acceptJobAndLaunch}
              onClose={closePanel}
              onOpenJob={openDecision}
              onAction={runDecisionAction}
              onCommand={requestCommand}
              onOutcome={recordOutcome}
              onSync={runSync}
              onSetSync={setSync}
              onAuth={setAuth}
              onNotification={openNotification}
              notify={notify}
            />
          )}
          {assistantOpen && (
            <ChatbotDrawer
              messages={assistantMessages}
              input={assistantInput}
              setInput={setAssistantInput}
              busy={assistantBusy}
              tool={assistantTool}
              onSend={sendAssistant}
              onStop={() => assistantAbort.current?.abort()}
              onClear={() => setAssistantMessages([])}
              onClose={() => setAssistantOpen(false)}
              mode={brainxMode}
              settings={assistantSettings}
              setSettings={setAssistantSettings}
              contextJob={selectedDecisionJob}
            />
          )}
          {pendingCommand && (
            <CommandConfirm
              pending={pendingCommand}
              reasons={brainxDismissReasons}
              onClose={() => setPendingCommand(null)}
              onConfirm={(reason?: string) =>
                applyCommand(pendingCommand.job, pendingCommand.command, reason)
              }
            />
          )}
        </>
      )}
      {toast && <WorkbenchToast toast={toast} onDismiss={dismissToast} />}
    </div>
  );
}
