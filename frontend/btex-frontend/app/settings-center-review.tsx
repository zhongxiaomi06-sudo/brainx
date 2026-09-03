"use client";

import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Cpu,
  Database,
  ExternalLink,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Tags,
  UserRound,
} from "lucide-react";
import { PersonalModelPanel } from "./personal-model-panel";
import "./settings-center-review.css";

export type SettingsSection = "profile" | "model" | "direction" | "connections" | "strategy" | "diagnostics";
type ConnectionState = "healthy" | "attention" | "offline";

export type SettingsCenterData = {
  profile: {
    consultantId: string;
    displayName: string;
    keywords: string[];
    note: string | null;
    feishuAuthorized: boolean;
    feishuNeedsReauth: boolean;
  };
  ttc: { connected: boolean; userName: string | null; expiresAt: string | null; needsReauth: boolean };
  talent: { backend: string; connected: boolean; schema: string; database: string | null; host: string | null; degraded: string | null };
  strategy: { policyVersion: string | null; customized: boolean | null };
  sync: {
    state: "READY" | "INCOMPLETE" | "ERROR" | "EMPTY";
    rowsRead: number | null;
    rowsExpected: number | null;
    updatedAt: string | null;
    errors: string[];
    fieldReport: { schemaVersion: string; totalRows: number; filterableFields: string[]; unavailableFilters: string[] } | null;
  };
};

type SettingsCenterReviewProps = {
  data: SettingsCenterData;
  initialSection?: SettingsSection;
  review?: boolean;
  onBack?: () => void;
  onAction?: (action: "edit-profile" | "connect-ttc" | "reauthorize-feishu" | "open-strategy" | "refresh-diagnostics") => void;
};

const sectionGroups = [
  { label: "个人", items: [
    { id: "profile", label: "个人资料", icon: UserRound },
    { id: "model", label: "我的模型", icon: Cpu },
    { id: "direction", label: "方向画像", icon: Tags },
  ] },
  { label: "工作台", items: [
    { id: "strategy", label: "推荐策略", icon: SlidersHorizontal },
    { id: "connections", label: "数据连接", icon: Database },
    { id: "diagnostics", label: "同步诊断", icon: Activity },
  ] },
] as const;

const sectionCopy: Record<SettingsSection, { title: string; description: string }> = {
  profile: { title: "个人资料", description: "管理当前登录身份和顾问资料。" },
  model: { title: "我的模型", description: "为你的飞书私聊 Agent 配置供应商、模型和个人密钥。" },
  direction: { title: "方向画像", description: "查看真实参与推荐的关键词，以及仅供记录的画像备注。" },
  connections: { title: "数据连接", description: "管理 TTC、飞书和人才库的真实连接状态。" },
  strategy: { title: "推荐策略", description: "查看当前策略版本，并进入独立策略审核页面。" },
  diagnostics: { title: "同步诊断", description: "核对职位快照、字段能力和最近同步异常。" },
};

function StatusPill({ state, children }: { state: ConnectionState; children: string }) {
  const Icon = state === "healthy" ? CheckCircle2 : AlertTriangle;
  return <span className={`settings-status ${state}`}><Icon aria-hidden="true" />{children}</span>;
}

function SettingGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-group"><h2>{title}</h2><div className="settings-rows">{children}</div></section>;
}

function SettingRow({ label, description, value, action }: { label: string; description?: string; value?: ReactNode; action?: ReactNode }) {
  return <div className="settings-row"><div><b>{label}</b>{description && <p>{description}</p>}</div>{value && <div className="settings-row-value">{value}</div>}{action}</div>;
}

function ProfilePanel({ data, onAction }: SettingsCenterReviewProps) {
  const authorized = data.profile.feishuAuthorized && !data.profile.feishuNeedsReauth;
  return <div className="settings-panel-stack">
    <SettingGroup title="身份">
      <SettingRow label="显示名称" description="工作台和协作记录中显示的姓名" value={data.profile.displayName || "—"} />
      <SettingRow label="系统身份" description="后端用于隔离顾问数据的标识" value={data.profile.consultantId || "—"} />
      <SettingRow label="飞书身份" description="用于登录、花名册校验和顾问数据隔离" value={<StatusPill state={authorized ? "healthy" : "attention"}>{authorized ? "已授权" : "需要重新授权"}</StatusPill>} action={!authorized && <button className="settings-inline-action" type="button" onClick={() => onAction?.("reauthorize-feishu")}><ExternalLink />重新授权</button>} />
    </SettingGroup>
    <SettingGroup title="资料操作">
      <SettingRow label="编辑个人资料" description="修改显示名称、方向关键词和画像备注" action={<button className="settings-inline-action" type="button" onClick={() => onAction?.("edit-profile")}>打开编辑</button>} />
    </SettingGroup>
  </div>;
}

function DirectionPanel({ data, onAction, review }: SettingsCenterReviewProps) {
  return <div className="settings-panel-stack">
    <SettingGroup title="当前生效">
      <SettingRow label="方向关键词" description="当前 scorer 实际读取并参与方向匹配" value={<div className="settings-keywords">{data.profile.keywords.length ? data.profile.keywords.map(keyword => <span key={keyword}>{keyword}</span>) : <em>尚未设置</em>}</div>} />
      <SettingRow label="画像备注" description="当前不进入 scorer，仅供顾问记录" value={data.profile.note || "—"} />
    </SettingGroup>
    <div className="settings-honesty-note"><AlertTriangle /><p><b>{review ? "结构化偏好仍在审核。" : "结构化偏好尚未开放。"}</b> 排除项和硬约束没有后端字段及评分语义，本页不会提前开放保存。</p></div>
    <button className="settings-primary-action" type="button" onClick={() => onAction?.("edit-profile")}><Tags />{review ? "进入方向画像审核" : "查看当前能力说明"}</button>
  </div>;
}

function ConnectionsPanel({ data, onAction }: SettingsCenterReviewProps) {
  const ttcHealthy = data.ttc.connected && !data.ttc.needsReauth;
  const feishuHealthy = data.profile.feishuAuthorized && !data.profile.feishuNeedsReauth;
  const talentHealthy = data.talent.backend === "mysql" && data.talent.connected && !data.talent.degraded;
  return <div className="settings-panel-stack"><SettingGroup title="已配置的数据源">
    <SettingRow label="TTC 职位系统" description={`真实职位来源 · ${data.ttc.userName || "未识别用户"} · 凭证有效期 ${data.ttc.expiresAt || "—"}`} value={<StatusPill state={ttcHealthy ? "healthy" : "attention"}>{ttcHealthy ? "已连接" : "需要处理"}</StatusPill>} action={!ttcHealthy && <button className="settings-inline-action" type="button" onClick={() => onAction?.("connect-ttc")}><RefreshCw />更新凭证</button>} />
    <SettingRow label="飞书身份" description="登录身份、花名册校验与顾问隔离" value={<StatusPill state={feishuHealthy ? "healthy" : "attention"}>{feishuHealthy ? "已授权" : "需要授权"}</StatusPill>} action={!feishuHealthy && <button className="settings-inline-action" type="button" onClick={() => onAction?.("reauthorize-feishu")}><ExternalLink />前往授权</button>} />
    <SettingRow label="人才库" description={`${data.talent.backend || "—"} · ${data.talent.database || "未连接数据库"} · ${data.talent.schema}`} value={<StatusPill state={talentHealthy ? "healthy" : data.talent.connected ? "attention" : "offline"}>{talentHealthy ? "MySQL 已连接" : data.talent.connected ? "降级运行" : "未连接"}</StatusPill>} />
  </SettingGroup>{data.talent.degraded && <div className="settings-honesty-note"><AlertTriangle /><p>{data.talent.degraded}</p></div>}</div>;
}

function StrategyPanel({ data, onAction, review }: SettingsCenterReviewProps) {
  return <div className="settings-panel-stack"><SettingGroup title="当前策略">
    <SettingRow label="策略版本" description="当前工作台记录的推荐策略版本" value={data.strategy.policyVersion || "—"} />
    <SettingRow label="权重状态" description="硬规则不会被个人权重覆盖" value={data.strategy.customized === null ? "待确认" : data.strategy.customized ? "自定义权重" : "系统基线"} />
    <SettingRow label="画像输入" description="仅统计当前真实保存的方向关键词" value={`${data.profile.keywords.length} 个关键词`} />
  </SettingGroup><div className="settings-honesty-note"><AlertTriangle /><p>后端尚无只读 dry-run 契约，当前不能在这里直接保存策略变化。</p></div><button className="settings-primary-action" type="button" onClick={() => onAction?.("open-strategy")}><SlidersHorizontal />{review ? "进入推荐策略审核" : "查看当前能力说明"}</button></div>;
}

function DiagnosticsPanel({ data, onAction }: SettingsCenterReviewProps) {
  const complete = data.sync.state === "READY";
  const report = data.sync.fieldReport;
  return <div className="settings-panel-stack">
    <SettingGroup title="最近职位快照">
      <SettingRow label="同步状态" description={data.sync.updatedAt ? `最近更新 ${data.sync.updatedAt}` : "尚无更新时间"} value={<StatusPill state={complete ? "healthy" : data.sync.state === "ERROR" ? "offline" : "attention"}>{complete ? "同步完整" : data.sync.state === "EMPTY" ? "暂无快照" : data.sync.state === "ERROR" ? "同步失败" : "同步不完整"}</StatusPill>} />
      <SettingRow label="读取进度" description="读取行数 / 预期行数" value={`${data.sync.rowsRead ?? "—"} / ${data.sync.rowsExpected ?? "—"}`} />
      <SettingRow label="错误数量" value={String(data.sync.errors.length)} action={<button className="settings-inline-action" type="button" onClick={() => onAction?.("refresh-diagnostics")}><RefreshCw />重新读取</button>} />
    </SettingGroup>
    <SettingGroup title="TTC 字段能力">
      {!report ? <SettingRow label="尚无字段报告" description="完成一次 TTC 同步后才会生成可筛选字段报告" value="—" /> : <><SettingRow label="报告版本" value={report.schemaVersion} /><SettingRow label="报告职位数" value={String(report.totalRows)} /><SettingRow label="允许筛选" value={report.filterableFields.join("、") || "—"} /><SettingRow label="暂不开放" value={report.unavailableFilters.join("、") || "—"} /></>}
    </SettingGroup>
    {!!data.sync.errors.length && <ul className="settings-errors">{data.sync.errors.map(error => <li key={error}>{error}</li>)}</ul>}
  </div>;
}

export function SettingsCenterReview({ data, initialSection = "profile", review = true, onBack, onAction }: SettingsCenterReviewProps) {
  const [active, setActive] = useState<SettingsSection>(initialSection);
  const [query, setQuery] = useState("");
  const visibleGroups = useMemo(() => sectionGroups.map(group => ({ ...group, items: group.items.filter(item => item.label.includes(query.trim())) })).filter(group => group.items.length), [query]);
  const props = { data, initialSection, review, onBack, onAction };
  const copy = sectionCopy[active];
  return <div className="settings-center-review">
    <aside className="settings-sidebar">
      <button className="settings-back" type="button" onClick={onBack}><ArrowLeft />返回应用</button>
      <label className="settings-search"><Search /><span className="sr-only">搜索设置</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索设置…" /></label>
      <nav aria-label="设置分组">{visibleGroups.map(group => <section key={group.label}><h2>{group.label}</h2>{group.items.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={active === id ? "active" : ""} aria-current={active === id ? "page" : undefined} onClick={() => setActive(id)}><Icon /><span>{label}</span></button>)}</section>)}</nav>
      <div className="settings-sidebar-account"><span>{data.profile.displayName.trim().slice(0, 1) || "M"}</span><div><b>{data.profile.displayName}</b><small>{data.profile.consultantId}</small></div></div>
    </aside>
    <main className="settings-main"><header><span className="settings-eyebrow">SETTINGS</span><h1>{copy.title}</h1><p>{copy.description}</p></header><div className="settings-section-content">
      {active === "profile" && <ProfilePanel {...props} />}
      {active === "model" && <PersonalModelPanel />}
      {active === "direction" && <DirectionPanel {...props} />}
      {active === "connections" && <ConnectionsPanel {...props} />}
      {active === "strategy" && <StrategyPanel {...props} />}
      {active === "diagnostics" && <DiagnosticsPanel {...props} />}
    </div></main>
  </div>;
}
