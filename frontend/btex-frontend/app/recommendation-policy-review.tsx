"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  FlaskConical,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import "./recommendation-policy-review.css";

export type PolicyDimensionKey = "direction" | "activity" | "similarity" | "capacity" | "outcomes" | "exploration";
export type PolicyAvailability = "available" | "partial" | "unavailable";

export type PolicyDimension = {
  key: PolicyDimensionKey;
  label: string;
  basis: string;
  availability: PolicyAvailability;
  availabilityNote: string;
};

export type PolicyPreviewItem = {
  id: string;
  role: string;
  company: string;
  fromRank: number;
  toRank: number;
  reason: string;
};

export type RecommendationPolicyData = {
  policyVersion: string;
  profileLabel: string;
  initialWeights: Record<PolicyDimensionKey, number>;
  dimensions: PolicyDimension[];
  hardRules: string[];
  preview: {
    contractReady: boolean;
    items: PolicyPreviewItem[];
  };
};

type PolicyMode = "steady" | "balanced" | "explore" | "custom";

type RecommendationPolicyReviewProps = {
  data: RecommendationPolicyData;
  onRequestPreview?: (weights: Record<PolicyDimensionKey, number>) => void;
  onSave?: (weights: Record<PolicyDimensionKey, number>) => void;
};

const modeDefinitions: { id: Exclude<PolicyMode, "custom">; name: string; label: string; description: string; weights: Record<PolicyDimensionKey, number> }[] = [
  { id: "steady", name: "稳健", label: "优先证据充分", description: "更重视方向、活跃度与当前跟进容量。", weights: { direction: 30, activity: 25, similarity: 15, capacity: 20, outcomes: 5, exploration: 5 } },
  { id: "balanced", name: "均衡", label: "沿用当前基线", description: "使用 baseline-1.1 已实现的六维比例。", weights: { direction: 25, activity: 20, similarity: 15, capacity: 15, outcomes: 15, exploration: 10 } },
  { id: "explore", name: "探索", label: "扩大新机会范围", description: "提高确定性探索配额，仍受硬规则约束。", weights: { direction: 20, activity: 15, similarity: 15, capacity: 15, outcomes: 5, exploration: 30 } },
];

const availabilityCopy: Record<PolicyAvailability, string> = {
  available: "可计算",
  partial: "部分可计算",
  unavailable: "暂不可用",
};

function rebalanceWeights(
  current: Record<PolicyDimensionKey, number>,
  key: PolicyDimensionKey,
  nextValue: number,
  dimensions: PolicyDimension[],
) {
  const next = { ...current, [key]: nextValue };
  const locked = dimensions.filter(item => item.key !== key && item.availability === "unavailable");
  const adjustable = dimensions.filter(item => item.key !== key && item.availability !== "unavailable");
  const remaining = Math.max(0, 100 - nextValue - locked.reduce((sum, item) => sum + current[item.key], 0));
  const currentTotal = adjustable.reduce((sum, item) => sum + current[item.key], 0);
  let assigned = 0;
  adjustable.forEach((item, index) => {
    const value = index === adjustable.length - 1
      ? remaining - assigned
      : Math.max(0, Math.round((current[item.key] / (currentTotal || adjustable.length)) * remaining));
    next[item.key] = value;
    assigned += value;
  });
  return next;
}

function AvailabilityBadge({ value }: { value: PolicyAvailability }) {
  return <span className={`policy-availability ${value}`}>{value === "available" ? <CheckCircle2 /> : <AlertTriangle />}{availabilityCopy[value]}</span>;
}

export function RecommendationPolicyReview({ data, onRequestPreview, onSave }: RecommendationPolicyReviewProps) {
  const balanced = modeDefinitions.find(item => item.id === "balanced")!;
  const [mode, setMode] = useState<PolicyMode>("balanced");
  const [weights, setWeights] = useState(data.initialWeights || balanced.weights);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const total = useMemo(() => Object.values(weights).reduce((sum, value) => sum + value, 0), [weights]);
  const missingCount = data.dimensions.filter(item => item.availability !== "available").length;

  const chooseMode = (nextMode: Exclude<PolicyMode, "custom">) => {
    const definition = modeDefinitions.find(item => item.id === nextMode)!;
    setMode(nextMode);
    setWeights({ ...definition.weights });
  };

  const changeWeight = (key: PolicyDimensionKey, value: number) => {
    setMode("custom");
    setWeights(current => rebalanceWeights(current, key, value, data.dimensions));
  };

  return <div className="policy-review">
    <header className="policy-review-heading">
      <div><span className="policy-kicker">RECOMMENDATION POLICY</span><h1>推荐策略</h1><p>先选择业务意图，再检查数据是否足够；权重不能绕过硬规则。</p></div>
      <div className="policy-version"><small>当前后端策略</small><b>{data.policyVersion}</b><span>{data.profileLabel}</span></div>
    </header>

    <section className="policy-section">
      <header><div><span className="policy-step">01</span><div><h2>选择推荐模式</h2><p>三个模式是待审核的产品定义；“均衡”与当前 baseline-1.1 完全一致。</p></div></div><span className="policy-draft-label"><FlaskConical />Storybook 审核定义</span></header>
      <div className="policy-mode-grid">
        {modeDefinitions.map(item => <button key={item.id} type="button" className={mode === item.id ? "active" : ""} aria-pressed={mode === item.id} onClick={() => chooseMode(item.id)}><span>{item.name}</span><b>{item.label}</b><p>{item.description}</p><small>{Object.values(item.weights).join(" / ")}</small></button>)}
      </div>
      <button className={`policy-advanced-toggle${advancedOpen ? " active" : ""}`} type="button" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen(open => !open)}><SlidersHorizontal /><span><b>高级自定义</b><small>仅调整有数据依据的软权重</small></span><ChevronDown /></button>
      {advancedOpen && <div className="policy-dimensions">
        <div className="policy-dimensions-head"><span>六维权重</span><b className={total === 100 ? "valid" : "invalid"}>合计 {total}%</b></div>
        {data.dimensions.map(dimension => <label className={`policy-dimension-row ${dimension.availability}`} key={dimension.key}>
          <span className="policy-dimension-copy"><span><b>{dimension.label}</b><AvailabilityBadge value={dimension.availability} /></span><small>{dimension.basis}</small><em>{dimension.availabilityNote}</em></span>
          <input aria-label={`${dimension.label}权重`} type="range" min="0" max="60" value={weights[dimension.key]} disabled={dimension.availability === "unavailable"} onChange={event => changeWeight(dimension.key, Number(event.target.value))} />
          <output>{weights[dimension.key]}%</output>
        </label>)}
        <p className="policy-normalize-note">调整任一可用维度时，其余可调维度按当前比例自动平衡，合计保持 100%。暂不可用维度锁定，避免把缺失数据包装成有效配置。</p>
      </div>}
    </section>

    <section className="policy-section">
      <header><div><span className="policy-step">02</span><div><h2>检查证据可用性</h2><p>状态来自评分 breakdown 和顾问当前数据，不是固定的系统承诺。</p></div></div><span className={`policy-readiness${missingCount ? " attention" : ""}`}>{missingCount ? `${missingCount} 维需要注意` : "六维可用"}</span></header>
      <div className="policy-evidence-grid">
        {data.dimensions.map(dimension => <article key={dimension.key}><AvailabilityBadge value={dimension.availability} /><b>{dimension.label}</b><p>{dimension.availabilityNote}</p></article>)}
      </div>
    </section>

    <section className="policy-section policy-preview-section">
      <header><div><span className="policy-step">03</span><div><h2>保存前查看变化</h2><p>预览必须由后端对同一快照执行只读 dry-run，前端不自行猜排名。</p></div></div></header>
      {!data.preview.contractReady ? <div className="policy-preview-blocked"><FlaskConical /><div><b>变化预览接口尚未接通</b><p>需要后端新增不落库、不晋升策略版本的 dry-run 契约；接通前不能声称某个职位会上升或下降。</p></div><button type="button" disabled>等待后端契约</button></div> : <>
        <div className="policy-contract-note"><FlaskConical /><span><b>脱敏契约示例</b> · 用于审核变化列表的字段和层级，不代表线上真实排名。</span></div>
        <button className="policy-preview-button" type="button" onClick={() => onRequestPreview?.(weights)}><RefreshCw />重新生成变化预览</button>
        <div className="policy-preview-list">{data.preview.items.map(item => {
          const up = item.toRank < item.fromRank;
          return <article key={item.id}><span className={`policy-rank-change ${up ? "up" : "down"}`}>{up ? <ArrowUp /> : <ArrowDown />}#{item.fromRank} → #{item.toRank}</span><div><b>{item.role}</b><small>{item.company}</small><p>{item.reason}</p></div></article>;
        })}</div>
      </>}
    </section>

    <section className="policy-hard-rules">
      <header><ShieldCheck /><div><b>不可调整的硬规则</b><p>以下条件优先于任何模式和权重。</p></div></header>
      <div>{data.hardRules.map(rule => <span key={rule}><LockKeyhole />{rule}</span>)}</div>
    </section>

    <footer className="policy-review-footer"><div><b>{mode === "custom" ? "自定义草稿" : modeDefinitions.find(item => item.id === mode)?.name + "模式"}</b><span>六维合计 {total}% · 尚未写入正式系统</span></div><button type="button" disabled={!data.preview.contractReady || total !== 100} onClick={() => onSave?.(weights)}>确认保存策略</button></footer>
  </div>;
}
