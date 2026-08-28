"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  ChevronRight,
  Clock3,
  Eye,
  MapPin,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import "./recommendation-queue-v2-review.css";

export type RecommendationDecisionTier = "TODAY" | "WEEK" | "VERIFY";
export type RecommendationConfidence = "SUFFICIENT" | "PARTIAL" | "INSUFFICIENT";
export type RecommendationCardAction = "ADD" | "WATCH" | "DISMISS" | "GO_PROJECT";

export type RecommendationReason = {
  code: string;
  text: string;
  evidence: string;
  occurredAt: string | null;
};

export type RecommendationQueueItem = {
  projectId: string;
  rank: number;
  tier: RecommendationDecisionTier;
  role: string;
  company: string;
  cities: string[];
  relation: string | null;
  activeState: string | null;
  hc: number | null;
  currentStage: string | null;
  recentActivity: { label: string; occurredAt: string | null } | null;
  pipeline: string | null;
  reasons: RecommendationReason[];
  risk: string | null;
  confidence: RecommendationConfidence;
  factsUpdatedAt: string | null;
  engagementLabel: string | null;
  legalActions: RecommendationCardAction[];
};

type RecommendationQueueV2ReviewProps = {
  items: RecommendationQueueItem[];
  pageIndex: number;
  totalCount: number;
  evaluatedCount: number;
  runId: string;
  generatedAt: string;
  policyVersion: string;
  loading?: boolean;
  error?: string | null;
  newRunAvailable?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onRefreshRun?: () => void;
  onOpen: (item: RecommendationQueueItem) => void;
  onAction: (item: RecommendationQueueItem, action: RecommendationCardAction) => Promise<void> | void;
};

const PAGE_SIZE = 20;
const tierMeta: Record<RecommendationDecisionTier, { label: string; signal: number }> = {
  TODAY: { label: "今天推进", signal: 3 },
  WEEK: { label: "本周观察", signal: 2 },
  VERIFY: { label: "待核验", signal: 1 },
};
const confidenceLabel: Record<RecommendationConfidence, string> = {
  SUFFICIENT: "事实充分",
  PARTIAL: "部分事实待确认",
  INSUFFICIENT: "事实不足",
};
const actionLabel: Record<RecommendationCardAction, string> = {
  ADD: "加入我的项目",
  WATCH: "观察",
  DISMISS: "暂不考虑",
  GO_PROJECT: "去我的项目",
};

function display(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "" || value === "UNKNOWN") return "待确认";
  return String(value);
}

function displayDate(value: string | null) {
  if (!value) return "时间待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(date);
}

function DecisionPriorityBadge({ tier }: { tier: RecommendationDecisionTier }) {
  const meta = tierMeta[tier];
  return <span className={`recommendation-tier is-${tier.toLowerCase()}`} aria-label={`${meta.label}，${meta.signal}格信号`}>
    <b>{meta.label}</b><i>{[1, 2, 3].map(value => <span className={value <= meta.signal ? "active" : ""} key={value} />)}</i>
  </span>;
}

function RecommendationCard({ item, onOpen, onAction }: {
  item: RecommendationQueueItem;
  onOpen: (item: RecommendationQueueItem) => void;
  onAction: (item: RecommendationQueueItem, action: RecommendationCardAction) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState<RecommendationCardAction | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const reasons = item.reasons.slice(0, 2);
  const risk = item.risk || "暂未发现阻断风险";
  const perform = async (action: RecommendationCardAction) => {
    if (busy) return;
    setBusy(action);
    setFeedback(null);
    try {
      await onAction(item, action);
      setFeedback({ tone: "success", text: `${actionLabel[action]}已记录` });
    } catch (error) {
      setFeedback({ tone: "error", text: error instanceof Error ? error.message : "操作失败，请重试" });
    } finally {
      setBusy(null);
    }
  };
  return <article className="recommendation-v2-card" tabIndex={0} aria-label={`${item.role} · ${item.company}`}
    onClick={() => onOpen(item)} onKeyDown={event => { if (event.key === "Enter" && event.target === event.currentTarget) onOpen(item); }}>
    <header>
      <div className="recommendation-v2-rank"><span>#{item.rank}</span><DecisionPriorityBadge tier={item.tier} /></div>
      <div className="recommendation-v2-identity"><h3>{item.role || "职位待确认"}</h3><p><BriefcaseBusiness />{item.company || "公司待确认"}<span><MapPin />{item.cities.length ? item.cities.join("、") : "城市待确认"}</span></p></div>
      <button type="button" className="recommendation-v2-open" aria-label={`查看 ${item.role} 判断`} onClick={event => { event.stopPropagation(); onOpen(item); }}><ChevronRight /></button>
    </header>

    <div className="recommendation-v2-body">
      <dl className="recommendation-v2-facts">
        <div><dt>关系</dt><dd>{display(item.relation)}</dd></div>
        <div><dt>状态</dt><dd>{display(item.activeState)}</dd></div>
        <div><dt>HC</dt><dd>{display(item.hc)}</dd></div>
        <div><dt>阶段</dt><dd>{display(item.currentStage)}</dd></div>
        <div><dt>最近活动</dt><dd>{item.recentActivity ? `${item.recentActivity.label} · ${displayDate(item.recentActivity.occurredAt)}` : "待确认"}</dd></div>
        <div><dt>Pipeline</dt><dd>{display(item.pipeline)}</dd></div>
      </dl>

      <section className="recommendation-v2-reasons">
        <h4>推荐理由</h4>
        {reasons.length ? <ol>{reasons.map(reason => <li key={reason.code}><span>{reason.text}</span><small>{reason.evidence} · {displayDate(reason.occurredAt)}</small></li>)}</ol> : <p>暂无已验证推荐理由</p>}
        {reasons.length === 1 && <small className="recommendation-v2-missing">暂无第二条已验证理由</small>}
      </section>
    </div>

    <div className="recommendation-v2-status-row">
      <div className={`recommendation-v2-risk${item.risk ? "" : " is-clear"}`}><AlertTriangle /><span><b>{item.risk ? "需要注意" : "风险检查"}</b>{risk}</span></div>
      <div className="recommendation-v2-confidence"><ShieldCheck /><span><b>{confidenceLabel[item.confidence]}</b><small><Clock3 />{displayDate(item.factsUpdatedAt)} 更新</small></span></div>
    </div>

    <footer onClick={event => event.stopPropagation()}>
      <div className="recommendation-v2-actions">
        {item.legalActions.includes("ADD") && <button type="button" className="primary" disabled={!!busy} onClick={() => void perform("ADD")}>{busy === "ADD" ? <RefreshCw className="spin" /> : <Check />}加入我的项目</button>}
        {item.legalActions.includes("GO_PROJECT") && <button type="button" className="primary" disabled={!!busy} onClick={() => void perform("GO_PROJECT")}><ArrowRight />去我的项目</button>}
        {item.legalActions.includes("WATCH") && <button type="button" disabled={!!busy} onClick={() => void perform("WATCH")}><Eye />观察</button>}
        {item.legalActions.includes("DISMISS") && <button type="button" className="quiet" disabled={!!busy} onClick={() => void perform("DISMISS")}>暂不考虑</button>}
      </div>
      {item.engagementLabel && <span className="recommendation-v2-engagement">{item.engagementLabel}</span>}
      {feedback && <p className={`recommendation-v2-feedback is-${feedback.tone}`} role="status">{feedback.text}</p>}
    </footer>
  </article>;
}

export function RecommendationQueueV2Review({
  items, pageIndex, totalCount, generatedAt,
  loading = false, error = null, newRunAvailable = false, onPrevious, onNext,
  onRefreshRun, onOpen, onAction,
}: RecommendationQueueV2ReviewProps) {
  const pageItems = items.slice(0, PAGE_SIZE);
  const start = pageItems.length ? pageIndex * PAGE_SIZE + 1 : 0;
  const end = pageItems.length ? start + pageItems.length - 1 : 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  return <section className="recommendation-v2-queue" aria-label="新版推荐队列审核稿">
    <header className="recommendation-v2-summary">
      <h2>推荐队列</h2>
      <p><span>岗位数量：<b>{totalCount}</b></span><span>更新时间：<b>{displayDate(generatedAt)}</b></span></p>
    </header>
    {newRunAvailable && <div className="recommendation-v2-new-run" role="status"><RefreshCw /><span><b>有新一轮判断可用</b>当前页面仍保持原排序，不会静默刷新。</span><button type="button" onClick={onRefreshRun}>查看新一轮</button></div>}
    {error && <div className="recommendation-v2-page-error" role="alert"><AlertTriangle /><span><b>这一页没有加载成功</b>{error}</span><button type="button" onClick={onNext}>重试</button></div>}
    <div className={`recommendation-v2-list${loading ? " is-loading" : ""}`} aria-busy={loading}>
      {pageItems.map(item => <RecommendationCard key={item.projectId} item={item} onOpen={onOpen} onAction={onAction} />)}
      {!pageItems.length && !error && <div className="recommendation-v2-empty">这一页没有推荐岗位</div>}
    </div>
    <footer className="recommendation-v2-pagination">
      <span>已显示 {start}–{end} / {totalCount}</span>
      <b>第 {pageIndex + 1} / {totalPages} 页 · 每页 20 条</b>
      <div><button type="button" disabled={loading || pageIndex === 0} onClick={onPrevious}><ArrowLeft />上一页</button><button type="button" disabled={loading || end >= totalCount} onClick={onNext}>下一页 · 20 条<ArrowRight /></button></div>
    </footer>
  </section>;
}
