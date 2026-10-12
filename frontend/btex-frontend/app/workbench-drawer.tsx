import { useEffect, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import {
  brainxFetch,
  mapReplayData,
  type BackendReplay,
  type BrainxReplay,
  type OpenmaiResult,
} from "./brainx-api";
import {
  type DecisionEvent,
  type EngagementCommand,
  type EngagementState,
  type Outcome,
} from "./decision-demo";
import { legalActions, type DecisionAction, type DecisionJob, type MembershipRelation } from "./workbench-model";
import { CommitmentLoopPanel } from "./engagement-loop";
import { newestEvents } from "./job-detail-data";
import { OpenmaiPanel } from "./openmai-panel";
import { DrawerSection } from "./workbench-controls";
import { ManualFactSection } from "./workbench-facts";
import { TalentSupplySection } from "./workbench-talent-supply";

function DecisionMetric({
  label,
  value,
  emphasis,
  helpOpen,
  onHelpToggle,
}: {
  label: string;
  value: string | number;
  emphasis?: string;
  helpOpen?: boolean;
  onHelpToggle?: () => void;
}) {
  return (
    <div className="decision-metric">
      <small>{label}</small>
      {onHelpToggle && (
        <button
          className="metric-help"
          type="button"
          onClick={onHelpToggle}
          aria-label={`解释${label}`}
          aria-expanded={helpOpen}
        >
          !
        </button>
      )}
      <b className={emphasis}>{value}</b>
    </div>
  );
}

function DecisionDrawer({
  job,
  tab,
  completed,
  engagement,
  events,
  outcomes,
  openmai,
  onRerunOpenmai,
  mode,
  legalMap,
  replayData,
  onReplay,
  onFactsUpdated,
  onCommitmentUpdated,
  onMembership,
  notify,
  onTab,
  onAction,
  onCommand,
  onOutcome,
}: {
  job: DecisionJob;
  tab: "judgement" | "engagement" | "trail" | "replay";
  completed: string[];
  engagement: EngagementState;
  events: DecisionEvent[];
  outcomes: Outcome[];
  openmai: OpenmaiResult | null;
  onRerunOpenmai: (jobId: string, searchBrief?: string) => void;
  mode: "connecting" | "connected" | "offline";
  legalMap: Record<string, EngagementCommand[]>;
  replayData?: BrainxReplay;
  onReplay: (jobId: string, data: BrainxReplay) => void;
  onFactsUpdated: () => Promise<void>;
  onCommitmentUpdated: (jobId: string) => Promise<void>;
  onMembership: (job: DecisionJob, relation: MembershipRelation) => Promise<void>;
  notify: (text: string) => void;
  onTab: (tab: "judgement" | "engagement" | "trail" | "replay") => void;
  onAction: (job: DecisionJob, action: DecisionAction) => void;
  onCommand: (job: DecisionJob, command: EngagementCommand) => void;
  onOutcome: (job: DecisionJob, stage: Outcome["stage"], rating?: number, note?: string) => void;
}) {
  const requestFactEdit = () => onTab("judgement");
  const verifyComplete = job.actions.some(
    (action) => action.kind === "verify" && completed.includes(`${job.id}:${action.id}`),
  );
  // verify 完成后回到判断页补录事实；setState 推迟到宏任务，避免在 effect 里同步级联渲染
  useEffect(() => {
    if (!verifyComplete || mode === "connecting") return;
    const timer = window.setTimeout(requestFactEdit, 0);
    return () => window.clearTimeout(timer);
  }, [job.id, verifyComplete, mode]);
  const replayFetchKey =
    tab === "replay" && mode === "connected" && job?.brainxDecisionId
      ? `${job.id}:${job.brainxDecisionId}`
      : null;
  const [replaySettledKey, setReplaySettledKey] = useState<string | null>(null);
  useEffect(() => {
    if (!replayFetchKey || replayData) return;
    // replayFetchKey 非空已蕴含 decisionId 存在；取出局部变量仅为类型收窄
    const decisionId = job.brainxDecisionId;
    if (!decisionId) return;
    let cancelled = false;
    brainxFetch<BackendReplay>(`/api/v1/decisions/${encodeURIComponent(decisionId)}/replay`)
      .then((data) => {
        if (!cancelled) onReplay(job.id, mapReplayData(data));
      })
      .catch(() => {
        if (!cancelled) setReplaySettledKey(replayFetchKey);
      });
    return () => {
      cancelled = true;
    };
  }, [replayFetchKey, tab, mode, job?.id, job?.brainxDecisionId, replayData, onReplay]);
  // 加载态由「回放请求是否已了结」派生：请求进行中即视为 loading，无需在 effect 里同步置位
  const replayLoading = Boolean(
    replayFetchKey && !replayData && replaySettledKey !== replayFetchKey,
  );
  return (
    <>
      {tab === "judgement" ? (
        <>
          <div className="drawer-metrics">
            <DecisionMetric label="项目推进" value={job.globalScore} />
            <DecisionMetric label="探索机会" value={job.explorationScore} />
            <DecisionMetric label="个人适配" value={job.personalScore} />
            <DecisionMetric label="最终得分" value={job.finalScore} emphasis="final" />
          </div>
          <ManualFactSection job={job} mode={mode} onUpdated={onFactsUpdated} notify={notify} />
          <DrawerSection title="为什么现在做" collapsible defaultOpen={false}>
            <ul className="explanations">
              {job.scoreNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </DrawerSection>
          {job.risks.length > 0 && (
            <DrawerSection title="风险与缺失" collapsible defaultOpen={false}>
              <ul className="explanations risks">
                {job.risks.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </DrawerSection>
          )}
          <DrawerSection title="证据来源" collapsible defaultOpen={false}>
            <div className="evidence-list">
              {job.evidence.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </DrawerSection>
          <TalentSupplySection job={job} mode={mode} />
          <DrawerSection title="当前建议">
            <div className="drawer-actions">
              {job.actions.map((action) => {
                const complete = completed.includes(`${job.id}:${action.id}`);
                return (
                  <button
                    key={action.id}
                    className={complete ? "completed" : ""}
                    onClick={() => onAction(job, action)}
                    disabled={complete}
                  >
                    <span>
                      <b>
                        {complete ? "已记录：" : ""}
                        {action.label}
                      </b>
                      <small>{action.detail}</small>
                    </span>
                    {complete ? <Check /> : <ChevronRight />}
                  </button>
                );
              })}
            </div>
          </DrawerSection>
        </>
      ) : tab === "engagement" ? (
        <>
          <EngagementPanel
            job={job}
            state={engagement}
            outcomes={outcomes}
            mode={mode}
            legalMap={legalMap}
            onCommand={onCommand}
            onMembership={onMembership}
            onVerify={requestFactEdit}
            onUpdated={() => onCommitmentUpdated(job.id)}
            notify={notify}
          />
          <OpenmaiPanel jobId={job.id} openmai={openmai} mode={mode} onRerun={onRerunOpenmai} />
        </>
      ) : tab === "trail" ? (
        <DrawerSection title="决策轨迹">
          <div className="trail-list">
            {events.length ? (
              newestEvents(events).map((event) => (
                <div key={event.id}>
                  <time>{event.at}</time>
                  <b>{event.type}</b>
                  <small>{event.reason || "顾问工作台"}</small>
                </div>
              ))
            ) : (
              <p className="muted">尚无操作记录</p>
            )}
          </div>
        </DrawerSection>
      ) : (
        <ReplayPanel
          job={job}
          events={events}
          outcomes={outcomes}
          replayData={replayData}
          loading={replayLoading}
        />
      )}
    </>
  );
}

function EngagementPanel({
  job,
  state,
  outcomes,
  mode,
  legalMap,
  onCommand,
  onMembership,
  onVerify,
  onUpdated,
  notify,
}: {
  job: DecisionJob;
  state: EngagementState;
  outcomes: Outcome[];
  mode: "connecting" | "connected" | "offline";
  legalMap: Record<string, EngagementCommand[]>;
  onCommand: (job: DecisionJob, command: EngagementCommand) => void;
  onMembership: (job: DecisionJob, relation: MembershipRelation) => Promise<void>;
  onVerify: () => void;
  onUpdated: () => Promise<void>;
  notify: (text: string) => void;
}) {
  const actions =
    mode === "connected"
      ? legalMap[job.id] || []
      : legalActions(job, state).filter((action) => action !== "COMPLETE" && action !== "RELEASE");
  return (
    <CommitmentLoopPanel
      job={job}
      state={state}
      outcomes={outcomes}
      mode={mode}
      legal={actions}
      onCommand={(command) => onCommand(job, command)}
      onMembership={(relation) => onMembership(job, relation)}
      onVerify={onVerify}
      onUpdated={onUpdated}
      notify={notify}
    />
  );
}

function ReplayPanel({
  job,
  events,
  outcomes,
  replayData,
  loading,
}: {
  job: DecisionJob;
  events: DecisionEvent[];
  outcomes: Outcome[];
  replayData?: BrainxReplay;
  loading?: boolean;
}) {
  const replay = replayData
    ? {
        decisionId: replayData.decisionId,
        runId: replayData.decisionId,
        snapshotAt: replayData.snapshotAt,
        policyVersion: replayData.policyVersion,
        rank: replayData.rank,
        reasons: replayData.reasons,
        risks: replayData.risks,
        evidence: replayData.evidence,
      }
    : {
        decisionId: `D-${job.id.slice(4)}`,
        runId: "RUN-1842",
        snapshotAt: "2026-08-10 11:28",
        policyVersion: "Policy v1.2",
        rank: job.rank,
        reasons: job.scoreNotes,
        risks: job.scoreNotes.slice(0, 1),
        evidence: job.evidence,
      };
  const shownEvents = replayData ? replayData.events : events;
  const shownOutcomes = replayData ? replayData.outcomes : outcomes;
  return (
    <>
      <DrawerSection title="冻结决策快照">
        <dl className="facts">
          <div>
            <dt>快照时间</dt>
            <dd>{loading && !replayData ? "读取中…" : replay.snapshotAt}</dd>
          </div>
          <div>
            <dt>策略版本</dt>
            <dd>{replay.policyVersion}</dd>
          </div>
          <div>
            <dt>当时排名</dt>
            <dd>第 {replay.rank} 位</dd>
          </div>
          <div>
            <dt>决策编号</dt>
            <dd>{replay.decisionId}</dd>
          </div>
        </dl>
      </DrawerSection>
      <DrawerSection title="当时理由与风险">
        <ul className="explanations">
          {replay.reasons.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div className="evidence-list">
          {replay.evidence.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </DrawerSection>
      <DrawerSection title="后续操作">
        <div className="trail-list">
          {shownEvents.map((item) => (
            <div key={item.id}>
              <time>{item.at}</time>
              <b>{item.type}</b>
              <small>{item.reason || "顾问工作台"}</small>
            </div>
          ))}
        </div>
      </DrawerSection>
      <DrawerSection title="后续结果">
        {shownOutcomes.length ? (
          <div className="outcome-list">
            {shownOutcomes.map((item) => (
              <div key={item.id}>
                <b>{item.stage}</b>
                <span>{item.note || "已记录"}</span>
                <time>{item.at}</time>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">暂无结果记录；回放以上方冻结数据为准。</p>
        )}
      </DrawerSection>
    </>
  );
}


export { DecisionDrawer };
