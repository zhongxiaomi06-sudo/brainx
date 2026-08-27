"use client";

import { useEffect, useRef } from "react";
import {
  ArrowRight,
  BriefcaseBusiness,
  Check,
  Clock3,
  Database,
  ExternalLink,
  MapPin,
  X,
} from "lucide-react";
import "./job-detail-card-review.css";

export type JobDetailPipeline = Record<string, number> | null;

export type JobDetailRecommendation = {
  action: "FOLLOW" | "WATCH" | "HOLD";
  reasons: string[];
  risks: string[];
  generatedAt: string;
  policyVersion: string;
};

export type JobDetailEvent = {
  id: string;
  label: string;
  at: string;
};

export type JobDetailReviewData = {
  projectId: string;
  role: string;
  company: string;
  cities: string[];
  activeState: "OPEN" | "COOLING" | "CLOSED" | "UNKNOWN";
  hc: number | null;
  pipeline: JobDetailPipeline;
  ownerName: string | null;
  capturedAt: string | null;
  relation: string | null;
  companyType?: string | null;
  priority?: string | null;
  currentStage?: string | null;
  nextAction?: string | null;
  notes?: string | null;
  recommendation?: JobDetailRecommendation | null;
  events?: JobDetailEvent[];
  inMyProjects?: boolean;
};

export type JobDetailCardProps = {
  job: JobDetailReviewData;
  onClose: () => void;
  onAddToProjects?: (projectId: string) => void;
  onDismiss?: (projectId: string) => void;
  onOpenSource?: (projectId: string) => void;
};

const stateLabels = {
  OPEN: "招聘中",
  COOLING: "冷却中",
  CLOSED: "已关闭",
  UNKNOWN: "状态待确认",
} as const;

const actionLabels = {
  FOLLOW: "建议加入项目",
  WATCH: "建议持续观察",
  HOLD: "建议暂缓",
} as const;

const pipelineLabels: Record<string, string> = {
  sourcing: "寻访",
  recommendation: "推荐",
  recommended: "推荐",
  interview: "面试",
  offer: "Offer",
  onboard: "入职",
};

function displayDate(value: string | null | undefined) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function displayValue(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "" || value === "UNKNOWN") return "待确认";
  return String(value);
}

function pipelineItems(pipeline: JobDetailPipeline) {
  if (!pipeline) return [];
  return Object.entries(pipeline)
    .filter(([, value]) => Number.isFinite(value))
    .map(([key, value]) => ({ label: pipelineLabels[key.toLowerCase()] || key, value }));
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div><dt>{label}</dt><dd className={displayValue(value) === "待确认" ? "is-missing" : ""}>{displayValue(value)}</dd></div>;
}

export function JobDetailCard({
  job,
  onClose,
  onAddToProjects,
  onDismiss,
  onOpenSource,
}: JobDetailCardProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const pipeline = pipelineItems(job.pipeline);
  const recommendation = job.recommendation?.reasons.length ? job.recommendation : null;
  const recentEvents = (job.events || []).slice(0, 3);

  useEffect(() => {
    dialogRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return (
    <div className="job-detail-review-mask" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        ref={dialogRef}
        className="job-detail-review-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`job-detail-title-${job.projectId}`}
        tabIndex={-1}
      >
        <header className="job-detail-review-header">
          <span className="job-detail-review-mark" aria-hidden="true">{job.company.trim().slice(0, 1) || "?"}</span>
          <div>
            <span className="job-detail-review-eyebrow">TTC POSITION FACT</span>
            <h2 id={`job-detail-title-${job.projectId}`}>{job.role || "职位待确认"}</h2>
            <p>{job.company || "公司待确认"}</p>
          </div>
          <button type="button" className="job-detail-review-close" aria-label="关闭职位详情" onClick={onClose}><X /></button>
        </header>

        <div className="job-detail-review-summary">
          <span><MapPin />{job.cities.length ? job.cities.join("、") : "城市待确认"}</span>
          <span className={`is-${job.activeState.toLowerCase()}`}>{stateLabels[job.activeState]}</span>
          <span>HC {job.hc ?? "待确认"}</span>
          <span><Clock3 />{displayDate(job.capturedAt)}</span>
        </div>

        <div className="job-detail-review-scroll">
          <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><BriefcaseBusiness /></span><div><h3>核心职位事实</h3><p>只展示 TTC 与 BrainX 当前可以核验的字段</p></div></div>
            <dl className="job-detail-review-facts">
              <Fact label="职位编号" value={job.projectId} />
              <Fact label="主做顾问" value={job.ownerName} />
              <Fact label="与我的关系" value={job.relation} />
              <Fact label="当前阶段" value={job.currentStage} />
              <Fact label="客户类型" value={job.companyType} />
              <Fact label="优先级" value={job.priority} />
            </dl>
          </section>

          <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><ArrowRight /></span><div><h3>招聘进展</h3><p>结构化 Pipeline；缺失不等于零</p></div></div>
            {pipeline.length ? <div className="job-detail-review-pipeline">{pipeline.map((item, index) => <div key={`${item.label}-${index}`}><span>{item.label}</span><b>{item.value}</b></div>)}</div> : <div className="job-detail-review-empty">暂无可核验进展</div>}
            {(job.nextAction || job.notes) && <dl className="job-detail-review-facts is-wide">
              {job.nextAction && <Fact label="下一步动作" value={job.nextAction} />}
              {job.notes && <Fact label="备注" value={job.notes} />}
            </dl>}
          </section>

          {recommendation && <section className="job-detail-review-section is-recommendation">
            <div className="job-detail-review-section-title"><span><Check /></span><div><h3>今日建议</h3><p>{actionLabels[recommendation.action]} · {displayDate(recommendation.generatedAt)}</p></div></div>
            <ul>{recommendation.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {recommendation.risks.length > 0 && <div className="job-detail-review-risks"><b>待确认</b>{recommendation.risks.map((risk) => <span key={risk}>{risk}</span>)}</div>}
            <small>策略版本 {recommendation.policyVersion}</small>
          </section>}

          {recentEvents.length > 0 && <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><Clock3 /></span><div><h3>最近动态</h3><p>最近三条真实操作记录</p></div></div>
            <div className="job-detail-review-events">{recentEvents.map((event) => <div key={event.id}><i /><b>{event.label}</b><time>{displayDate(event.at)}</time></div>)}</div>
          </section>}

          <section className="job-detail-review-source">
            <Database />
            <span><b>TTC CRM 职位快照</b><small>最近同步 {displayDate(job.capturedAt)} · 缺失字段保持待确认</small></span>
            {onOpenSource && <button type="button" onClick={() => onOpenSource(job.projectId)}>查看来源<ExternalLink /></button>}
          </section>
        </div>

        {(onDismiss || onAddToProjects) && <footer className={`job-detail-review-actions${onDismiss && onAddToProjects ? "" : " is-single"}`}>
          {onDismiss && <button type="button" className="is-dismiss" onClick={() => onDismiss(job.projectId)}>暂不考虑</button>}
          {onAddToProjects && <button type="button" className="is-primary" disabled={job.inMyProjects} onClick={() => onAddToProjects(job.projectId)}>{job.inMyProjects ? "已加入我的项目" : "加入我的项目"}</button>}
        </footer>}
      </section>
    </div>
  );
}
