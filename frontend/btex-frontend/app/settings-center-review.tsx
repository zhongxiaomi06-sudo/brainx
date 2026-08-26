"use client";

import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  ExternalLink,
  RefreshCw,
  SlidersHorizontal,
  UserRound,
} from "lucide-react";
import "./settings-center-review.css";

export type SettingsSection = "profile" | "connections" | "strategy" | "diagnostics";

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
  ttc: {
    connected: boolean;
    userName: string | null;
    expiresAt: string | null;
    needsReauth: boolean;
  };
  talent: {
    backend: string;
    connected: boolean;
    schema: string;
    database: string | null;
    host: string | null;
    degraded: string | null;
  };
  strategy: {
    policyVersion: string | null;
    customized: boolean;
  };
  sync: {
    state: "READY" | "INCOMPLETE" | "ERROR" | "EMPTY";
    rowsRead: number | null;
    rowsExpected: number | null;
    updatedAt: string | null;
    errors: string[];
    fieldReport: {
      schemaVersion: string;
      totalRows: number;
      filterableFields: string[];
      unavailableFilters: string[];
    } | null;
  };
};

type SettingsCenterReviewProps = {
  data: SettingsCenterData;
  initialSection?: SettingsSection;
  onAction?: (action: "edit-profile" | "connect-ttc" | "reauthorize-feishu" | "open-strategy" | "refresh-diagnostics") => void;
};

const sections = [
  { id: "profile", label: "个人资料", detail: "身份与方向画像", icon: UserRound },
  { id: "connections", label: "数据连接", detail: "TTC、飞书与人才库", icon: Database },
  { id: "strategy", label: "推荐策略", detail: "策略版本与画像依据", icon: SlidersHorizontal },
  { id: "diagnostics", label: "同步诊断", detail: "快照与字段能力", icon: Activity },
] as const;

function StatusPill({ state, children }: { state: ConnectionState; children: string }) {
  const Icon = state === "healthy" ? CheckCircle2 : AlertTriangle;
  return <span className={`settings-status ${state}`}><Icon aria-hidden="true" />{children}</span>;
}

function Fact({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return <div className="settings-fact"><dt>{label}</dt><dd className={muted ? "muted" : ""}>{value}</dd></div>;
}

function ProfilePanel({ data, onAction }: SettingsCenterReviewProps) {
  const feishuState = data.profile.feishuAuthorized && !data.profile.feishuNeedsReauth;
  return <div className="settings-panel-stack">
    <section className="settings-card">
      <header><div><span className="settings-eyebrow">ACCOUNT</span><h2>登录身份</h2></div><StatusPill state={feishuState ? "healthy" : "attention"}>{feishuState ? "飞书已授权" : "需要重新授权"}</StatusPill></header>
      <dl className="settings-facts two-columns">
        <Fact label="显示名称" value={data.profile.displayName || "—"} />
        <Fact label="系统身份" value={data.profile.consultantId || "—"} />
      </dl>
      {!feishuState && <button className="settings-button secondary" type="button" onClick={() => onAction?.("reauthorize-feishu")}><ExternalLink />重新授权飞书</button>}
    </section>
    <section className="settings-card">
      <header><div><span className="settings-eyebrow">DIRECTION PROFILE</span><h2>方向画像</h2></div><button className="settings-text-button" type="button" onClick={() => onAction?.("edit-profile")}>编辑资料</button></header>
      <div className="settings-keywords" aria-label="画像关键词">
        {data.profile.keywords.length ? data.profile.keywords.map(keyword => <span key={keyword}>{keyword}</span>) : <em>尚未设置画像关键词</em>}
      </div>
      <div className="settings-note"><b>画像备注</b><p>{data.profile.note || "未填写；空值不会被当作推荐依据。"}</p></div>
      <p className="settings-source-note">数据依据：GET /api/v1/profile</p>
    </section>
  </div>;
}

function ConnectionCard({ title, description, state, status, facts, action }: {
  title: string; description: string; state: ConnectionState; status: string;
  facts: { label: string; value: string; muted?: boolean }[]; action?: React.ReactNode;
}) {
  return <section className="settings-card connection-card">
    <header><div><span className="settings-eyebrow">LIVE CONNECTION</span><h2>{title}</h2></div><StatusPill state={state}>{status}</StatusPill></header>
    <p className="settings-card-description">{description}</p>
    <dl className="settings-facts">{facts.map(fact => <Fact key={fact.label} {...fact} />)}</dl>
    {action}
  </section>;
}

function ConnectionsPanel({ data, onAction }: SettingsCenterReviewProps) {
  const ttcHealthy = data.ttc.connected && !data.ttc.needsReauth;
  const talentHealthy = data.talent.backend === "mysql" && data.talent.connected && !data.talent.degraded;
  const feishuHealthy = data.profile.feishuAuthorized && !data.profile.feishuNeedsReauth;
  return <div className="settings-connection-grid">
    <ConnectionCard title="TTC 职位系统" description="真实职位的权威来源。凭证只提交给后端，页面不会回显。" state={ttcHealthy ? "healthy" : "attention"} status={ttcHealthy ? "已连接" : "需要处理"} facts={[
      { label: "TTC 用户", value: data.ttc.userName || "—", muted: !data.ttc.userName },
      { label: "凭证有效期", value: data.ttc.expiresAt || "—", muted: !data.ttc.expiresAt },
    ]} action={!ttcHealthy ? <button className="settings-button" type="button" onClick={() => onAction?.("connect-ttc")}><RefreshCw />连接或更新凭证</button> : undefined} />
    <ConnectionCard title="飞书身份" description="用于登录身份、花名册校验和顾问数据隔离。" state={feishuHealthy ? "healthy" : "attention"} status={feishuHealthy ? "已授权" : "需要授权"} facts={[
      { label: "当前顾问", value: data.profile.displayName || "—" },
      { label: "授权状态", value: data.profile.feishuNeedsReauth ? "授权已失效" : data.profile.feishuAuthorized ? "有效" : "未授权" },
    ]} action={!feishuHealthy ? <button className="settings-button" type="button" onClick={() => onAction?.("reauthorize-feishu")}><ExternalLink />前往飞书授权</button> : undefined} />
    <ConnectionCard title="人才库" description="人才数据旁路，不替代 TTC 职位源。" state={talentHealthy ? "healthy" : data.talent.connected ? "attention" : "offline"} status={talentHealthy ? "MySQL 已连接" : data.talent.connected ? "降级运行" : "未连接"} facts={[
      { label: "当前后端", value: data.talent.backend || "—" },
      { label: "数据库", value: data.talent.database || "—", muted: !data.talent.database },
      { label: "建表状态", value: data.talent.schema || "—" },
      ...(data.talent.degraded ? [{ label: "诊断", value: data.talent.degraded, muted: true }] : []),
    ]} />
    <p className="settings-source-note settings-grid-note">数据依据：/api/v1/ttc/connect、/api/v1/profile、/api/v1/talent/health</p>
  </div>;
}

function StrategyPanel({ data, onAction }: SettingsCenterReviewProps) {
  return <div className="settings-panel-stack">
    <section className="settings-card strategy-summary">
      <header><div><span className="settings-eyebrow">RECOMMENDATION POLICY</span><h2>当前推荐依据</h2></div><StatusPill state={data.strategy.policyVersion ? "healthy" : "attention"}>{data.strategy.policyVersion ? "策略已加载" : "版本待确认"}</StatusPill></header>
      <dl className="settings-facts two-columns">
        <Fact label="策略版本" value={data.strategy.policyVersion || "—"} muted={!data.strategy.policyVersion} />
        <Fact label="权重状态" value={data.strategy.customized ? "自定义权重" : "系统基线"} />
        <Fact label="画像关键词" value={data.profile.keywords.length ? `${data.profile.keywords.length} 个已设置` : "尚未设置"} muted={!data.profile.keywords.length} />
        <Fact label="硬规则" value="不在此处修改" />
      </dl>
      <div className="settings-honesty-note"><AlertTriangle /><p><b>本轮不提前制作六维设置。</b><br />推荐模式、字段可用性和变化预览将在独立 Storybook 任务中审核，避免把尚未确认的数据能力包装成可用配置。</p></div>
      <button className="settings-button secondary" type="button" onClick={() => onAction?.("open-strategy")}><SlidersHorizontal />查看后续审核范围</button>
      <p className="settings-source-note">数据依据：工作台 current_policy_version 与 GET /api/v1/profile</p>
    </section>
  </div>;
}

function DiagnosticsPanel({ data, onAction }: SettingsCenterReviewProps) {
  const complete = data.sync.state === "READY";
  const report = data.sync.fieldReport;
  return <div className="settings-panel-stack">
    <section className="settings-card">
      <header><div><span className="settings-eyebrow">SYNC SNAPSHOT</span><h2>最近职位快照</h2></div><StatusPill state={complete ? "healthy" : data.sync.state === "ERROR" ? "offline" : "attention"}>{complete ? "同步完整" : data.sync.state === "EMPTY" ? "暂无快照" : data.sync.state === "ERROR" ? "同步失败" : "同步不完整"}</StatusPill></header>
      <dl className="settings-facts two-columns">
        <Fact label="读取行数" value={data.sync.rowsRead == null ? "—" : String(data.sync.rowsRead)} muted={data.sync.rowsRead == null} />
        <Fact label="预期行数" value={data.sync.rowsExpected == null ? "—" : String(data.sync.rowsExpected)} muted={data.sync.rowsExpected == null} />
        <Fact label="最近更新" value={data.sync.updatedAt || "—"} muted={!data.sync.updatedAt} />
        <Fact label="错误数量" value={String(data.sync.errors.length)} muted={!data.sync.errors.length} />
      </dl>
      {!!data.sync.errors.length && <ul className="settings-errors">{data.sync.errors.map(error => <li key={error}>{error}</li>)}</ul>}
      <button className="settings-button secondary" type="button" onClick={() => onAction?.("refresh-diagnostics")}><RefreshCw />重新读取诊断</button>
    </section>
    <section className="settings-card">
      <header><div><span className="settings-eyebrow">FIELD CAPABILITIES</span><h2>TTC 字段能力</h2></div>{report && <span className="settings-schema">Schema {report.schemaVersion}</span>}</header>
      {!report ? <div className="settings-empty"><Database /><b>尚无字段报告</b><p>完成一次 TTC 同步后，这里才会展示可筛选字段。</p></div> : <>
        <Fact label="报告职位数" value={String(report.totalRows)} />
        <div className="settings-capability-group"><b>当前允许筛选</b><div>{report.filterableFields.map(field => <span className="available" key={field}>{field}</span>)}</div></div>
        <div className="settings-capability-group"><b>当前不开放</b><div>{report.unavailableFilters.map(field => <span key={field}>{field}</span>)}</div></div>
      </>}
      <p className="settings-source-note">数据依据：GET /api/v1/ttc/field-report</p>
    </section>
  </div>;
}

export function SettingsCenterReview({ data, initialSection = "profile", onAction }: SettingsCenterReviewProps) {
  const [active, setActive] = useState<SettingsSection>(initialSection);
  const props = { data, initialSection, onAction };
  return <div className="settings-center-review">
    <header className="settings-page-heading"><span className="settings-eyebrow">SETTINGS CENTER</span><h1>设置中心</h1><p>身份、数据连接和系统诊断统一收口；只展示已有接口能够证明的状态。</p></header>
    <div className="settings-layout">
      <nav className="settings-section-nav" aria-label="设置分组">
        {sections.map(({ id, label, detail, icon: Icon }) => <button key={id} type="button" className={active === id ? "active" : ""} aria-current={active === id ? "page" : undefined} onClick={() => setActive(id)}><Icon aria-hidden="true" /><span><b>{label}</b><small>{detail}</small></span></button>)}
      </nav>
      <div className="settings-section-content">
        {active === "profile" && <ProfilePanel {...props} />}
        {active === "connections" && <ConnectionsPanel {...props} />}
        {active === "strategy" && <StrategyPanel {...props} />}
        {active === "diagnostics" && <DiagnosticsPanel {...props} />}
      </div>
    </div>
  </div>;
}
