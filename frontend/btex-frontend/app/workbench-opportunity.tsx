"use client";

import {
  Check,
  ChevronRight,
  FolderPlus,
  Star,
} from "lucide-react";
import {
  stateLabel,
  type EngagementCommand,
  type EngagementState,
} from "./decision-demo";
import type { ManualFactField } from "./brainx-api";

type DecisionGroup =
  | "RESULT_CLOSURE"
  | "ACTIVE_ADVANCEMENT"
  | "NEW_VALIDATION"
  | "MAINTENANCE"
  | "EXCLUDE";

type DecisionAction = {
  id: string;
  label: string;
  kind: "verify" | "advance" | "watch" | "skip";
  detail: string;
};

type Eligibility = "ELIGIBLE" | "VERIFY_REQUIRED" | "BLOCKED" | "EXCLUDED";
type DecisionDirection = "paid" | "growth" | "marketing";
type SourceMode = "COCKPIT_CONTEXT" | "MARKET_ONLY";
type DecisionFact = {
  value: string | number | null;
  effective_value: string | number | null;
  source: "SYNC" | "MANUAL" | "UNKNOWN" | "LOCAL";
  updated_at: string | null;
};

type DecisionJob = {
  id: string;
  rank: number;
  company: string;
  role: string;
  direction: DecisionDirection;
  sourceMode: SourceMode;
  group: DecisionGroup;
  eligibility: Eligibility;
  globalScore: number | string;
  finalScore: number | string;
  personalScore: number | string;
  explorationScore: number | string;
  evidenceCoverage: number | null;
  recommendation: string;
  recentSignal: string;
  facts: Record<string, string>;
  scoreNotes: string[];
  factFields?: Partial<Record<ManualFactField, DecisionFact>>;
  risks: string[];
  evidence: string[];
  actions: DecisionAction[];
  brainxLegal?: EngagementCommand[];
  brainxDecisionId?: string;
};

type PickFolder = {
  id: string;
  name: string;
  jobIds: string[];
};

type OpportunityRowModel = {
  rank: number;
  company: string;
  role: string;
  city: string | null;
  stage: string | null;
  relation: string | null;
  source: string;
  summary: string;
  score: string | number;
  coverage: number | null;
  exploration: string | number;
};

const decisionGroupTitle: Record<DecisionGroup, string> = {
  RESULT_CLOSURE: "结果收口",
  ACTIVE_ADVANCEMENT: "高动能推进",
  NEW_VALIDATION: "新机会验证",
  MAINTENANCE: "维护观察",
  EXCLUDE: "暂不推荐",
};

function evidenceCoveragePercent(coverage: number | null) {
  return coverage === null ? null : Math.round(coverage <= 1 ? coverage * 100 : coverage);
}

function DecisionMetric({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string | number;
  emphasis?: string;
}) {
  return (
    <div className="decision-metric">
      <small>{label}</small>
      <b className={emphasis}>{value}</b>
    </div>
  );
}

export function DecisionZone({
  tone,
  title,
  jobs,
  isContext,
  completed,
  engagement,
  open,
  onAction,
  onFeedback,
  tray,
  onToggleTray,
  folderMode,
  folders,
  onAssignFolder,
  toolbar,
  anchorId,
}: {
  tone: "accepted" | "pending";
  title: string;
  subtitle: string;
  jobs: DecisionJob[];
  isContext: boolean;
  completed: string[];
  engagement: Record<string, EngagementState>;
  open: (job: DecisionJob, tab?: "facts" | "judgement" | "engagement" | "trail" | "replay") => void;
  onAction: (job: DecisionJob, action: DecisionAction) => void;
  onFeedback: (job: DecisionJob, reason?: string) => void;
  tray: string[];
  onToggleTray: (id: string) => void;
  folderMode: boolean;
  folders: PickFolder[];
  onAssignFolder: (jobId: string, folderId: string) => void;
  toolbar?: React.ReactNode;
  anchorId?: string;
}) {
  return (
    <section
      id={anchorId}
      className={`decision-zone ${tone}${isContext ? " is-context" : ""}`}
    >
      <div className="decision-group-head">
        <div>
          <h2>
            {title}
            <span className="decision-zone-kicker">
              {tone === "accepted" ? "TODAY'S COMMITMENTS" : "NOT YET ACCEPTED"}
            </span>
          </h2>
        </div>
        <span>{isContext ? `当前查看 · ${jobs.length}` : `${jobs.length} 个`}</span>
      </div>
      {toolbar}
      <div className="pick-grid">
        {jobs.map((job, index) => (
          <OpportunityRow
            key={job.id}
            job={{ ...job, rank: index + 1 }}
            completed={completed}
            engagement={engagement[job.id] || "NEW"}
            open={open}
            onAction={onAction}
            onFeedback={onFeedback}
            inTray={tray.includes(job.id)}
            onToggleTray={onToggleTray}
            folderMode={folderMode}
            folders={folders}
            onAssignFolder={onAssignFolder}
          />
        ))}
      </div>
    </section>
  );
}

function toOpportunityRowModel(job: DecisionJob): OpportunityRowModel {
  return {
    rank: job.rank,
    company: job.company,
    role: job.role,
    city: job.facts["城市"] || null,
    stage: job.facts["当前阶段"] || null,
    relation: job.facts["职位关系"] || null,
    source: job.facts["数据来源"] || "职位市场",
    summary: job.recommendation,
    score: job.finalScore,
    coverage: evidenceCoveragePercent(job.evidenceCoverage),
    exploration: job.explorationScore,
  };
}

function OpportunityRow({
  job,
  completed,
  engagement,
  open,
  onAction,
  onFeedback,
  inTray,
  onToggleTray,
  folderMode,
  folders,
  onAssignFolder,
}: {
  job: DecisionJob;
  completed: string[];
  engagement: EngagementState;
  open: (job: DecisionJob, tab?: "facts" | "judgement" | "engagement" | "trail" | "replay") => void;
  onAction: (job: DecisionJob, action: DecisionAction) => void;
  onFeedback: (job: DecisionJob, reason?: string) => void;
  inTray: boolean;
  onToggleTray: (id: string) => void;
  folderMode: boolean;
  folders: PickFolder[];
  onAssignFolder: (jobId: string, folderId: string) => void;
}) {
  const action = job.actions.find((item) => !completed.includes(`${job.id}:${item.id}`))
    || job.actions[0]
    || { id: "view", label: "完整判断", kind: "verify" as const, detail: "查看完整判断" };
  const actionComplete = completed.includes(`${job.id}:${action.id}`);
  const row = toOpportunityRowModel(job);

  return (
    <article
      className={`pick-card concept-job-card${inTray ? " in-tray" : ""}`}
      onClick={() => open(job)}
    >
      <button
        className="pick-add"
        onClick={(event) => {
          event.stopPropagation();
          onToggleTray(job.id);
        }}
        aria-label={inTray ? "移出精选盘" : "收藏到精选盘"}
        title={inTray ? "移出精选盘" : "收藏到精选盘"}
      >
        {inTray ? <Check /> : <Star />}
      </button>
      <button
        className="pick-card-feedback"
        onClick={(event) => {
          event.stopPropagation();
          onFeedback(job);
        }}
        aria-label="不感兴趣"
        title="不感兴趣"
      >
        ×
      </button>
      <div className="pick-card-leading">
        <div className="pick-card-brand" aria-hidden="true">{row.company.slice(0, 1)}</div>
        <div className="pick-card-leading-copy">
          <div className="pick-card-rank">No.{String(row.rank).padStart(2, "0")}</div>
          <div className="pick-card-title"><b>{row.role}</b><span>{row.company}</span></div>
          <p className="pick-card-meta">
            {[row.city, row.stage, row.relation].filter(Boolean).join(" · ") || row.source}
          </p>
          <div className="pick-card-tags">
            <em>{decisionGroupTitle[job.group]}</em>
            {row.stage && <em>{row.stage}</em>}
            <em>{stateLabel[engagement]}</em>
          </div>
          <p className="pick-card-reco">{row.summary}</p>
        </div>
      </div>
      <div className="pick-card-rail">
        <div className="pick-card-scores">
          <DecisionMetric label="AI 匹配分" value={row.score} emphasis="final" />
          <DecisionMetric
            label="证据覆盖"
            value={row.coverage === null ? "—" : `${row.coverage}%`}
          />
          <DecisionMetric label="探索价值" value={row.exploration} />
        </div>
        {folderMode && (
          <div className="pick-card-folder" onClick={(event) => event.stopPropagation()}>
            <FolderPlus />
            <select
              className="field"
              value=""
              onChange={(event) => {
                if (event.target.value) onAssignFolder(job.id, event.target.value);
              }}
              aria-label={`将 ${job.company} 放入文件夹`}
            >
              <option value="">放入文件夹…</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>{folder.name}</option>
              ))}
            </select>
          </div>
        )}
        <div className="pick-card-foot">
          <span className="pick-card-actions">
            <button
              className={`pick-card-action${actionComplete ? " complete" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onAction(job, action);
              }}
              disabled={actionComplete}
            >
              {actionComplete ? "已记录" : action.label}<ChevronRight />
            </button>
          </span>
        </div>
      </div>
    </article>
  );
}
