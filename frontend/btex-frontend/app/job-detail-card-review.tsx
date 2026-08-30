"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BarChart3,
  BriefcaseBusiness,
  Check,
  Clock3,
  Database,
  ExternalLink,
  MapPin,
  X,
} from "lucide-react";
import { newestEvents } from "./job-detail-data";
import "./job-detail-card-review.css";

export type JobDetailPipeline = Record<string, number> | null;

export type JobDetailRecommendation = {
  action: "FOLLOW" | "WATCH" | "HOLD";
  score: number | null;
  evidenceCoverage: number | null;
  breakdown: JobDetailScoreDimension[];
  reasons: string[];
  risks: string[];
  generatedAt: string | null;
  policyVersion: string | null;
};

export type JobDetailScoreDimension = {
  dim: string;
  label: string;
  weight: number | null;
  score: number | null;
  weightedScore: number | null;
};

export type JobDetailEvent = {
  id: string;
  label: string;
  at: string | null;
  detail?: string | null;
};

export type JobDetailTab = "facts" | "judgement" | "engagement" | "trail" | "replay";

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
  sourceUrl?: string | null;
  engagementState?: string | null;
  inMyProjects?: boolean;
};

export type JobDetailCardProps = {
  job: JobDetailReviewData;
  onClose: () => void;
  onAddToProjects?: (projectId: string) => Promise<void> | void;
  onIgnore?: (projectId: string) => Promise<void> | void;
  onDismiss?: (projectId: string) => void;
  onOpenSource?: (projectId: string) => void;
  activeTab?: JobDetailTab;
  initialTab?: JobDetailTab;
  onTabChange?: (tab: JobDetailTab) => void;
  detailContent?: ReactNode;
  statusLabel?: string;
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

const scoreDimensions = [
  ["direction", "职位方向匹配"],
  ["activity", "项目活跃度与 Pipeline"],
  ["similarity", "与历史项目相似度"],
  ["capacity", "当前跟进容量"],
  ["outcomes", "历史行为与交付结果"],
  ["exploration", "探索额度"],
] as const;

function displayDate(value: string | null | undefined) {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
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

function percent(value: number | null) {
  return value === null ? "待确认" : `${Math.round(value * 100)}%`;
}

function scoreText(value: number | null) {
  return value === null ? "待确认" : `${Number(value.toFixed(1))} / 100`;
}

function JudgementContent({ job, recommendation }: {
  job: JobDetailReviewData;
  recommendation: JobDetailRecommendation | null;
}) {
  if (!recommendation) return <section className="job-detail-review-section is-recommendation">
    <div className="job-detail-review-empty">这个职位尚无真实推荐结果</div>
  </section>;
  const dimensions = scoreDimensions.map(([dim, label]) => {
    const found = recommendation.breakdown.find(item => item.dim === dim);
    return found || { dim, label, weight: null, score: null, weightedScore: null };
  });
  const suggestions = [
    { label: actionLabels[recommendation.action], source: "冻结推荐结论" },
    ...(job.nextAction ? [{ label: job.nextAction, source: "当前职位事实" }] : []),
  ];
  return <>
    <section className="job-detail-score-summary" aria-label="推荐评分摘要">
      <div><span>推荐指数</span><b>{recommendation.score ?? "待确认"}</b></div>
      <div><span>证据覆盖</span><b>{recommendation.evidenceCoverage === null ? "待确认" : `${recommendation.evidenceCoverage}%`}</b></div>
      <div><span>策略版本</span><b>{recommendation.policyVersion || "待确认"}</b></div>
    </section>
    <section className="job-detail-review-section">
      <div className="job-detail-review-section-title"><span><BarChart3 /></span><div><h3>评分依据</h3><p>后端冻结六维评分；缺失维度不按 0 分处理</p></div></div>
      <div className="job-detail-score-list">{dimensions.map(item => <div className={`job-detail-score-row${item.score === null ? " is-missing" : ""}`} key={item.dim}>
        <span><b>{item.label}</b><small>{item.weight === null ? "权重待确认" : `权重 ${percent(item.weight)}`}</small></span>
        <div className="job-detail-score-bar" role="progressbar" aria-label={item.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.score ?? undefined}><i style={{ width: `${Math.max(0, Math.min(100, item.score ?? 0))}%` }} /></div>
        <strong>{scoreText(item.score)}{item.weightedScore !== null && <small>贡献 {Number(item.weightedScore.toFixed(2))}</small>}</strong>
      </div>)}</div>
    </section>
    <section className="job-detail-review-section">
      <div className="job-detail-review-section-title"><span><Check /></span><div><h3>建议动作</h3><p>只展示冻结推荐和当前职位事实</p></div></div>
      <div className="job-detail-score-actions">{suggestions.map((item, index) => <div key={`${item.source}:${item.label}`}><span>{String(index + 1).padStart(2, "0")}</span><p><b>{item.label}</b><small>{item.source}</small></p></div>)}</div>
    </section>
    <section className="job-detail-review-section is-recommendation">
      <div className="job-detail-review-section-title"><span><Check /></span><div><h3>判断依据</h3><p>{displayDate(recommendation.generatedAt)}</p></div></div>
      <ul>{recommendation.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
      {recommendation.risks.length > 0 && <div className="job-detail-review-risks"><b>风险与缺失</b>{recommendation.risks.map(risk => <span key={risk}>{risk}</span>)}</div>}
    </section>
  </>;
}

function Fact({ label, value }: { label: string; value: string | number | null | undefined }) {
  return <div><dt>{label}</dt><dd className={displayValue(value) === "待确认" ? "is-missing" : ""}>{displayValue(value)}</dd></div>;
}

export function JobDetailCard({
  job,
  onClose,
  onAddToProjects,
  onIgnore,
  onDismiss,
  onOpenSource,
  activeTab,
  initialTab = "facts",
  onTabChange,
  detailContent,
  statusLabel,
}: JobDetailCardProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const [localTab, setLocalTab] = useState<JobDetailTab>(initialTab);
  const [adding, setAdding] = useState(false);
  const [ignoring, setIgnoring] = useState(false);
  const selectedTab = activeTab || localTab;
  const pipeline = pipelineItems(job.pipeline);
  const recommendation = job.recommendation
    && (job.recommendation.reasons.length > 0 || job.recommendation.breakdown.length > 0)
    ? job.recommendation : null;
  const recentEvents = newestEvents(job.events || []);
  const tabs: { id: JobDetailTab; label: string }[] = [
    { id: "facts", label: "职位事实" },
    { id: "judgement", label: "判断" },
    { id: "engagement", label: "跟进与结果" },
    { id: "trail", label: "决策轨迹" },
    { id: "replay", label: "回放" },
  ];
  const selectTab = (tab: JobDetailTab) => {
    if (tab === selectedTab) return;
    if (!activeTab) setLocalTab(tab);
    onTabChange?.(tab);
  };
  const addToProjects = async () => {
    if (!onAddToProjects || adding || job.inMyProjects) return;
    setAdding(true);
    try { await onAddToProjects(job.projectId); } finally { setAdding(false); }
  };
  const ignoreProject = async () => {
    if (!onIgnore || ignoring || !job.inMyProjects) return;
    setIgnoring(true);
    try { await onIgnore(job.projectId); } finally { setIgnoring(false); }
  };

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
          {statusLabel && <span className="is-workflow">{statusLabel}</span>}
        </div>

        <nav className="job-detail-review-tabs" aria-label="职位详情视图">
          {tabs.map(tab => <button key={tab.id} type="button" className={selectedTab === tab.id ? "active" : ""} aria-current={selectedTab === tab.id ? "page" : undefined} onClick={() => selectTab(tab.id)}>{tab.label}</button>)}
        </nav>

        <div className="job-detail-review-scroll">
          {selectedTab === "facts" ? <><section className="job-detail-review-section">
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
            {job.nextAction && <dl className="job-detail-review-facts is-wide">
              {job.nextAction && <Fact label="下一步动作" value={job.nextAction} />}
            </dl>}
          </section>

          <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><BriefcaseBusiness /></span><div><h3>备注与职位描述</h3><p>完整保留原始上下文；长内容在弹窗内滚动</p></div></div>
            {job.notes ? <p className="job-detail-review-notes">{job.notes}</p> : <div className="job-detail-review-empty">暂无备注或职位描述</div>}
          </section>

          <section className="job-detail-review-source">
            <Database />
            <span><b>TTC CRM 职位快照</b><small>最近同步 {displayDate(job.capturedAt)} · 缺失字段保持待确认</small></span>
            {onOpenSource && <button type="button" onClick={() => onOpenSource(job.projectId)}>查看来源<ExternalLink /></button>}
          </section>
          </> : detailContent || (selectedTab === "judgement" ? <JudgementContent job={job} recommendation={recommendation} /> : selectedTab === "engagement" ? <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><ArrowRight /></span><div><h3>跟进与结果</h3><p>项目关系、当前阶段和下一步动作</p></div></div>
            <dl className="job-detail-review-facts"><Fact label="跟进状态" value={job.engagementState} /><Fact label="与我的关系" value={job.relation} /><Fact label="当前阶段" value={job.currentStage} /><Fact label="下一步动作" value={job.nextAction} /></dl>
          </section> : selectedTab === "trail" ? <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><Clock3 /></span><div><h3>决策轨迹</h3><p>真实操作记录</p></div></div>
            {recentEvents.length ? <div className="job-detail-review-events">{recentEvents.map(event => <div key={event.id}><i /><span><b>{event.label}</b>{event.detail && <small>{event.detail}</small>}</span><time>{displayDate(event.at)}</time></div>)}</div> : <div className="job-detail-review-empty">尚无操作记录</div>}
          </section> : <section className="job-detail-review-section">
            <div className="job-detail-review-section-title"><span><Database /></span><div><h3>决策回放</h3><p>只展示后端已经冻结的推荐快照</p></div></div>
            <div className="job-detail-review-empty">尚无可回放的冻结决策</div>
          </section>)}
        </div>

        {(onDismiss || onIgnore || onAddToProjects) && <footer className={`job-detail-review-actions${[onDismiss, onIgnore, onAddToProjects].filter(Boolean).length === 1 ? " is-single" : ""}`}>
          {onDismiss && <button type="button" className="is-dismiss" onClick={() => onDismiss(job.projectId)}>暂不考虑</button>}
          {onIgnore && job.inMyProjects && <button type="button" className="is-ignore" disabled={ignoring} onClick={() => void ignoreProject()}>{ignoring ? "忽略中…" : "忽略"}</button>}
          {onAddToProjects && <button type="button" className="is-primary" disabled={job.inMyProjects || adding} onClick={() => void addToProjects()}>{job.inMyProjects ? "已加入我的项目" : adding ? "添加中…" : "加入我的项目"}</button>}
        </footer>}
      </section>
    </div>
  );
}
