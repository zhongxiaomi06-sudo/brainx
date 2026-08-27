"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileText,
  History,
  LockKeyhole,
  PencilLine,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Tags,
} from "lucide-react";
import "./direction-profile-review.css";

export type DirectionSignal = "keywords" | "history" | "missing";
export type ClassificationStatus = "classified" | "missing" | "manual";

export type DirectionClassification = {
  id: string;
  role: string;
  company: string;
  source: "market-csv" | "ttc";
  status: ClassificationStatus;
  primaryDirection: string | null;
  secondaryDirections: string[];
  isLeadership: boolean | null;
  confidence: number | null;
  matchedTerms: string[];
  excludedTerms: string[];
  version: string | null;
  evidence: string[];
  correctedFrom?: string | null;
};

export type DirectionProfileData = {
  consultant: string;
  keywords: string[];
  note: string | null;
  signal: DirectionSignal;
  historicalProjectCount: number;
  structuredProfile: {
    contractReady: boolean;
    preferred: string[];
    excluded: string[];
    hardConstraints: string[];
  };
  manualOverrideContractReady: boolean;
  classifications: DirectionClassification[];
};

type DirectionProfileReviewProps = {
  data: DirectionProfileData;
  onSaveKeywords?: (keywords: string[]) => void;
  onSaveStructuredProfile?: () => void;
  onCorrectClassification?: (id: string) => void;
};

const directionLabels: Record<string, string> = {
  PAID_ACQUISITION: "海外投放 / 效果营销",
  GROWTH_LEADERSHIP: "增长负责人",
  GTM_LEADERSHIP: "GTM / 商业化",
  DTC_GROWTH: "DTC / 电商增长",
  MARKETING_LEADERSHIP: "市场负责人",
  PRODUCT: "产品",
  ENGINEERING: "工程研发",
  DESIGN: "设计",
  OPERATIONS: "运营",
  SALES: "销售 / 商务",
  FINANCE: "财务 / 融资",
  OTHER: "其他",
};

const signalCopy: Record<DirectionSignal, { title: string; description: string; state: "healthy" | "attention" }> = {
  keywords: { title: "画像关键词生效中", description: "方向分优先使用当前关键词与职位文本的重合度。", state: "healthy" },
  history: { title: "使用历史项目兜底", description: "画像为空，方向分改用历史主做项目文本。", state: "attention" },
  missing: { title: "方向信号缺失", description: "画像和历史项目均为空，方向维记为缺失而不是 0 分。", state: "attention" },
};

function StatusBadge({ state, children }: { state: "healthy" | "attention" | "neutral"; children: string }) {
  return <span className={`direction-status ${state}`}>{state === "healthy" ? <CheckCircle2 /> : <AlertTriangle />}{children}</span>;
}

function ChipGroup({ items, empty, tone = "default" }: { items: string[]; empty: string; tone?: "default" | "exclude" | "hard" }) {
  return <div className={`direction-chips ${tone}`}>{items.length ? items.map(item => <span key={item}>{item}</span>) : <em>{empty}</em>}</div>;
}

function CurrentProfile({ data, onSaveKeywords }: DirectionProfileReviewProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.keywords.join("、"));
  const signal = signalCopy[data.signal];
  const save = () => {
    const keywords = [...new Set(draft.split(/[、,，\s]+/).map(value => value.trim()).filter(Boolean))].slice(0, 20);
    onSaveKeywords?.(keywords);
    setEditing(false);
  };
  return <section className="direction-section">
    <header><div><span className="direction-step">01</span><div><h2>当前已经生效的画像</h2><p>只展示现有后端和评分器实际读取的字段。</p></div></div><StatusBadge state={signal.state}>{signal.title}</StatusBadge></header>
    <div className="direction-current-grid">
      <article className="direction-current-card effective"><header><div><Tags /><b>方向关键词</b></div><span>参与推荐</span></header><ChipGroup items={data.keywords} empty="尚未设置关键词" />
        <p>{signal.description}</p><button type="button" onClick={() => setEditing(open => !open)}><PencilLine />编辑当前关键词</button>
        {editing && <div className="direction-keyword-editor"><label htmlFor="direction-keywords">最多 20 个，每个最长 20 字</label><textarea id="direction-keywords" value={draft} onChange={event => setDraft(event.target.value)} /><div><button type="button" onClick={() => setEditing(false)}>取消</button><button type="button" onClick={save}>保存审核动作</button></div></div>}
      </article>
      <article className="direction-current-card record-only"><header><div><FileText /><b>画像备注</b></div><span>仅供记录</span></header><p className="direction-note">{data.note || "尚未填写备注。"}</p><div className="direction-honesty"><AlertTriangle /><span>`profile_note` 当前不进入 scorer，不能把它描述为推荐依据。</span></div></article>
    </div>
    <div className="direction-signal-source"><History /><span>历史主做项目：{data.historicalProjectCount} 个</span><small>数据依据：GET /api/v1/profile 与 recommend.buildCtx</small></div>
  </section>;
}

function StructuredProfile({ data, onSaveStructuredProfile }: DirectionProfileReviewProps) {
  const ready = data.structuredProfile.contractReady;
  return <section className="direction-section">
    <header><div><span className="direction-step">02</span><div><h2>结构化偏好提案</h2><p>把偏好、排除项和硬约束分开，避免继续混在一个自由文本框。</p></div></div><StatusBadge state={ready ? "healthy" : "attention"}>{ready ? "契约可用" : "后端字段待补"}</StatusBadge></header>
    {!ready && <div className="direction-contract-warning"><LockKeyhole /><div><b>当前只能可靠保存方向关键词</b><p>排除项和硬约束尚无 profile 字段及评分语义；审核稿展示信息结构，但不会假装能够保存或生效。</p></div></div>}
    <div className="direction-structure-grid">
      <article><span className="direction-structure-icon prefer"><Sparkles /></span><b>偏好方向</b><p>用于提升与目标方向重合的职位，不自动排除其他职位。</p><ChipGroup items={data.structuredProfile.preferred} empty="暂无偏好" /></article>
      <article><span className="direction-structure-icon exclude"><SearchCheck /></span><b>明确排除</b><p>例如不做纯销售或特定方向；正式接入前必须定义匹配证据。</p><ChipGroup items={data.structuredProfile.excluded} empty="后端尚无字段" tone="exclude" /></article>
      <article><span className="direction-structure-icon hard"><ShieldCheck /></span><b>个人硬约束</b><p>例如城市或管理属性；不得与系统职位状态硬规则混为一谈。</p><ChipGroup items={data.structuredProfile.hardConstraints} empty="后端尚无字段" tone="hard" /></article>
    </div>
    <button className="direction-primary-action" type="button" disabled={!ready} onClick={onSaveStructuredProfile}><ShieldCheck />{ready ? "保存结构化画像" : "等待后端契约后保存"}</button>
  </section>;
}

function ClassificationCard({ item, canCorrect, onCorrect }: { item: DirectionClassification; canCorrect: boolean; onCorrect?: (id: string) => void }) {
  const classified = item.status !== "missing";
  return <article className={`classification-card ${item.status}`}>
    <header><div><small>{item.source === "market-csv" ? "市场 CSV 适配链" : "TTC 职位源"}</small><h3>{item.role}</h3><p>{item.company}</p></div><StatusBadge state={item.status === "manual" ? "healthy" : classified ? "neutral" : "attention"}>{item.status === "manual" ? "人工修正" : classified ? "已分类" : "暂无分类"}</StatusBadge></header>
    {!classified ? <div className="classification-missing"><AlertTriangle /><div><b>TTC 分类链尚未统一</b><p>现有 `job_classifications` 由市场 CSV 适配器生成，不能假装该职位已有分类。</p></div></div> : <>
      <dl className="classification-facts">
        <div><dt>主方向</dt><dd>{directionLabels[item.primaryDirection || ""] || item.primaryDirection || "—"}</dd></div>
        <div><dt>负责人属性</dt><dd>{item.isLeadership == null ? "—" : item.isLeadership ? "是" : "否"}</dd></div>
        <div><dt>置信度</dt><dd>{item.confidence == null ? "—" : `${Math.round(item.confidence * 100)}%`}</dd></div>
        <div><dt>分类版本</dt><dd>{item.version || "—"}</dd></div>
      </dl>
      {!!item.secondaryDirections.length && <div className="classification-line"><b>次方向</b><ChipGroup items={item.secondaryDirections.map(value => directionLabels[value] || value)} empty="无" /></div>}
      <div className="classification-line"><b>命中词</b><ChipGroup items={item.matchedTerms} empty="未记录命中词" /></div>
      {!!item.excludedTerms.length && <div className="classification-line"><b>排除词</b><ChipGroup items={item.excludedTerms} empty="无" tone="exclude" /></div>}
      <details className="classification-evidence"><summary>查看分类证据 <ChevronDown /></summary><ul>{item.evidence.map(value => <li key={value}>{value}</li>)}</ul></details>
      {item.status === "manual" && item.correctedFrom && <p className="classification-correction">人工从“{directionLabels[item.correctedFrom] || item.correctedFrom}”修正，原始判断保留用于审计。</p>}
    </>}
    <button className="classification-correct" type="button" disabled={!canCorrect} onClick={() => onCorrect?.(item.id)}><PencilLine />{canCorrect ? "修正分类" : "人工修正契约待补"}</button>
  </article>;
}

export function DirectionProfileReview({ data, onSaveKeywords, onSaveStructuredProfile, onCorrectClassification }: DirectionProfileReviewProps) {
  return <div className="direction-profile-review">
    <header className="direction-page-heading"><div><span className="direction-kicker">DIRECTION PROFILE</span><h1>方向画像与职位分类</h1><p>先区分已经生效的数据，再审核结构化画像和分类证据的未来形态。</p></div><div><small>当前顾问</small><b>{data.consultant}</b></div></header>
    <CurrentProfile data={data} onSaveKeywords={onSaveKeywords} />
    <StructuredProfile data={data} onSaveStructuredProfile={onSaveStructuredProfile} />
    <section className="direction-section">
      <header><div><span className="direction-step">03</span><div><h2>职位分类与证据</h2><p>每个分类必须能回到版本、置信度、命中词和原始证据。</p></div></div><StatusBadge state={data.manualOverrideContractReady ? "healthy" : "attention"}>{data.manualOverrideContractReady ? "人工修正契约示例" : "人工修正待接入"}</StatusBadge></header>
      {data.manualOverrideContractReady && <div className="direction-contract-example"><Sparkles /><span><b>脱敏契约示例</b> · 仅审核人工修正后的展示与审计方式，不代表正式数据库已有这些字段。</span></div>}
      <div className="classification-grid">{data.classifications.map(item => <ClassificationCard key={item.id} item={item} canCorrect={data.manualOverrideContractReady} onCorrect={onCorrectClassification} />)}</div>
    </section>
  </div>;
}
