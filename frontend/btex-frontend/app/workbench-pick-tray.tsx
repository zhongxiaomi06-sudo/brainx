"use client";

import { useRef } from "react";
import {
  Check,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import type { EngagementCommand } from "./decision-demo";
import type { ManualFactField } from "./brainx-api";

type DecisionGroup =
  | "RESULT_CLOSURE"
  | "ACTIVE_ADVANCEMENT"
  | "NEW_VALIDATION"
  | "MAINTENANCE"
  | "EXCLUDE";
type Eligibility = "ELIGIBLE" | "VERIFY_REQUIRED" | "BLOCKED" | "EXCLUDED";
type DecisionDirection = "paid" | "growth" | "marketing";
type SourceMode = "COCKPIT_CONTEXT" | "MARKET_ONLY";
type DecisionAction = {
  id: string;
  label: string;
  kind: "verify" | "advance" | "watch" | "skip";
  detail: string;
};
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

export function PickTray({
  trayJobs,
  featuredJobs,
  allJobs,
  folderMode,
  onFolderMode,
  folders,
  onRemoveTray,
  onToggleTray,
  onConfirmTray,
  onAssignFolder,
  onCreateFolder,
  open,
}: {
  trayJobs: DecisionJob[];
  featuredJobs: DecisionJob[];
  allJobs: DecisionJob[];
  folderMode: boolean;
  onFolderMode: () => void;
  folders: PickFolder[];
  onRemoveTray: (id: string) => void;
  onToggleTray: (id: string) => void;
  onConfirmTray: () => void;
  onAssignFolder: (jobId: string, folderId: string) => void;
  onCreateFolder: (name: string) => void;
  open: (job: DecisionJob) => void;
}) {
  if (folderMode) {
    return (
      <section className="pick-tray folder-mode" aria-label="职位文件夹">
        <div className="pick-tray-head">
          <div className="pick-tray-title">
            <span className="decision-zone-kicker">PICK FOLDERS</span>
            <b>文件夹</b>
          </div>
          <button className="btn quiet" onClick={onFolderMode}>
            <Sparkles />返回精选盘
          </button>
        </div>
        <div className="folder-create">
          <FolderPlus />
          <input
            className="field"
            placeholder="新建文件夹，如：周末回访"
            aria-label="新建文件夹名称"
            onKeyDown={(event) => {
              const target = event.target as HTMLInputElement;
              if (event.key === "Enter" && target.value.trim()) {
                onCreateFolder(target.value);
                target.value = "";
              }
            }}
          />
          <button
            className="btn"
            onClick={(event) => {
              const input = event.currentTarget.parentElement?.querySelector("input");
              if (input?.value.trim()) {
                onCreateFolder(input.value);
                input.value = "";
              }
            }}
          >
            新建
          </button>
        </div>
        <div className="folder-strips">
          {folders.map((folder) => (
            <FolderStrip
              key={folder.id}
              folder={folder}
              jobs={allJobs.filter((job) => folder.jobIds.includes(job.id))}
              open={open}
              onRemove={(jobId) => onAssignFolder(jobId, "")}
            />
          ))}
        </div>
      </section>
    );
  }

  const showcaseJobs = (trayJobs.length ? trayJobs : featuredJobs).slice(0, 4);
  return (
    <section className="pick-tray concept-showcase" aria-label="精选盘">
      <div className="pick-tray-head">
        <div className="pick-tray-title">
          <b>精选盘</b>
          <span className="decision-zone-kicker">MY PICK TRAY</span>
          <em>{trayJobs.length ? `${trayJobs.length} 已收藏` : "推荐预览"}</em>
        </div>
        <div className="pick-tray-actions">
          <button
            className="concept-showcase-link"
            type="button"
            onClick={() =>
              document
                .getElementById("opportunity-list")
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            查看全部<ChevronRight />
          </button>
          <button
            className="icon-btn concept-folder-button"
            onClick={onFolderMode}
            aria-label="打开精选文件夹"
            title="文件夹模式"
          >
            <FolderOpen />
          </button>
          <button
            className="btn primary"
            onClick={onConfirmTray}
            disabled={trayJobs.length === 0}
          >
            <Check />确定
          </button>
        </div>
      </div>
      <div className="pick-tray-plates">
        {showcaseJobs.map((job) => (
          <ShowcaseCard
            key={job.id}
            job={job}
            selected={trayJobs.some((item) => item.id === job.id)}
            open={open}
            onToggle={() => onToggleTray(job.id)}
            onRemove={() => onRemoveTray(job.id)}
          />
        ))}
      </div>
    </section>
  );
}

function ShowcaseCard({
  job,
  selected,
  open,
  onToggle,
  onRemove,
}: {
  job: DecisionJob;
  selected: boolean;
  open: (job: DecisionJob) => void;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const coverage = evidenceCoveragePercent(job.evidenceCoverage);
  return (
    <article
      className={`showcase-card${selected ? " selected" : ""}`}
      onClick={() => open(job)}
    >
      <button
        className="showcase-menu"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (selected) onRemove();
          else onToggle();
        }}
        aria-label={selected ? `从精选盘移除 ${job.company}` : `收藏 ${job.company}`}
        title={selected ? "移出精选盘" : "收藏到精选盘"}
      >
        {selected ? <Check /> : <Star />}
      </button>
      <b>{job.role}</b>
      <span>{job.company}</span>
      <small>{job.recentSignal}</small>
      <div>
        <strong>{job.finalScore}<i> 匹配分</i></strong>
        <em>{coverage === null ? "待确认" : `证据 ${coverage}%`}</em>
      </div>
    </article>
  );
}

function FolderStrip({
  folder,
  jobs,
  open,
  onRemove,
}: {
  folder: PickFolder;
  jobs: DecisionJob[];
  open: (job: DecisionJob) => void;
  onRemove: (jobId: string) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    scrollLeft: number;
    moved: boolean;
  } | null>(null);

  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !track.current) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      scrollLeft: track.current.scrollLeft,
      moved: false,
    };
    track.current.classList.add("is-dragging");
    track.current.setPointerCapture(event.pointerId);
  };
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !track.current || drag.current.pointerId !== event.pointerId) return;
    const delta = event.clientX - drag.current.startX;
    if (!drag.current.moved && Math.abs(delta) < 6) return;
    drag.current.moved = true;
    track.current.scrollLeft = drag.current.scrollLeft - delta;
  };
  const end = () => {
    track.current?.classList.remove("is-dragging");
    drag.current = null;
  };

  return (
    <div className="folder-strip">
      <div className="folder-strip-head">
        <b>{folder.name}</b><em>{jobs.length}</em>
      </div>
      <div
        className="folder-cards"
        ref={track}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      >
        {jobs.length ? jobs.map((job) => (
          <article className="folder-card" key={job.id} onClick={() => open(job)}>
            <div className="folder-card-top">
              <b>{job.company}</b>
              <button
                className="folder-card-x"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(job.id);
                }}
                aria-label={`从 ${folder.name} 移除 ${job.company}`}
              >
                <X />
              </button>
            </div>
            <span>{job.role}</span>
            <div className="folder-card-scores">
              <DecisionMetric label="探索" value={job.explorationScore} />
              <DecisionMetric label="最终" value={job.finalScore} emphasis="final" />
            </div>
            <small>{job.recentSignal}</small>
          </article>
        )) : <div className="folder-empty" aria-hidden="true" />}
      </div>
    </div>
  );
}
