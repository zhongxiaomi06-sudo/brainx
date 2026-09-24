"use client";

import { Building2, Cable, Cloud, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import type { ProviderConnection, SupermaiPlatform } from "./brainx-connections-api";
import "./connection-center.css";

const providers = {
  feishu: {
    name: "飞书",
    role: "BrainX 身份",
    description: "负责进入 BrainX 和调用已授权的飞书能力。登录只在飞书官方页面完成。",
    icon: ShieldCheck,
  },
  openmai: {
    name: "OpenMai",
    role: "人才搜索",
    description: "通过服务端授权搜索候选人，浏览器不保存访问密钥。",
    icon: Cloud,
  },
  supermai: {
    name: "SuperMai",
    role: "桌面找人",
    description: "复用本机已安装的 SuperMai，在招聘平台官方页面完成登录。",
    icon: Cable,
  },
  reloop: {
    name: "Reloop",
    role: "组织人才库",
    description: "由组织统一维护的人才库连接，无需个人重复登录。",
    icon: Building2,
  },
} as const;

const stateCopy = {
  connected: { label: "已连接", tone: "ready" },
  organization_managed: { label: "组织已连接", tone: "managed" },
  action_required: { label: "需要操作", tone: "action" },
  unavailable: { label: "暂不可用", tone: "offline" },
} as const;

const platformCopy: Record<SupermaiPlatform, string> = {
  boss: "BOSS",
  maimai: "脉脉",
  liepin: "猎聘",
};

type ConnectionCenterProps = {
  items: ProviderConnection[];
  loading?: boolean;
  error?: string;
  busyPlatform?: SupermaiPlatform | null;
  onRefresh: () => void;
  onStartSupermai: (platform: SupermaiPlatform) => void;
  onReauthorizeFeishu: () => void;
};

function CheckedAt({ value }: { value: string }) {
  const date = new Date(value);
  const text = Number.isNaN(date.getTime())
    ? "检查时间待确认"
    : `检查于 ${date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  return <small>{text}</small>;
}

function SupermaiActions({ item, busyPlatform, onStart }: {
  item: ProviderConnection;
  busyPlatform?: SupermaiPlatform | null;
  onStart: (platform: SupermaiPlatform) => void;
}) {
  const desktopReady = item.details?.desktop_available === true;
  return <div className="connection-platforms" aria-label="SuperMai 招聘平台">
    {(Object.keys(platformCopy) as SupermaiPlatform[]).map(platform => {
      const status = item.details?.platforms?.[platform];
      const loggedIn = status?.logged_in === true;
      const busy = busyPlatform === platform;
      return <button
        key={platform}
        type="button"
        className={loggedIn ? "is-connected" : ""}
        disabled={!desktopReady || !!busyPlatform}
        onClick={() => onStart(platform)}
      >
        <span><b>{platformCopy[platform]}</b><small>{loggedIn ? "已登录" : status?.running ? "等待官方登录" : "打开官方登录"}</small></span>
        {busy ? <LoaderCircle className="spin" aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}
      </button>;
    })}
    {!desktopReady && <p className="connection-platform-hint">请先打开本机已安装的 SuperMai，再刷新状态。</p>}
  </div>;
}

export function ConnectionCenter({ items, loading = false, error = "", busyPlatform = null,
  onRefresh, onStartSupermai, onReauthorizeFeishu }: ConnectionCenterProps) {
  const ready = items.filter(item => item.state === "connected" || item.state === "organization_managed").length;
  return <div className="connection-center">
    <header className="connection-center-hero">
      <div>
        <p className="connection-kicker">CONNECTION CENTER</p>
        <h1>连接中心</h1>
        <p>一个 BrainX 身份，统一查看飞书与三条找人链路。密码和验证码始终留在官方页面。</p>
      </div>
      <div className="connection-overview" aria-label="连接概览">
        <strong>{loading && items.length === 0 ? "—" : `${ready}/${items.length || 4}`}</strong>
        <span>已就绪</span>
        <button type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw className={loading ? "spin" : ""} aria-hidden="true" />刷新
        </button>
      </div>
    </header>

    {error && <div className="connection-alert" role="alert">
      <span>{error}</span><button type="button" onClick={onRefresh}>重新检查</button>
    </div>}

    <div className="connection-grid" aria-busy={loading}>
      {items.map(item => {
        const meta = providers[item.provider];
        const copy = stateCopy[item.state];
        const Icon = meta.icon;
        return <article className={`connection-card connection-${item.provider}`} key={item.provider}>
          <header>
            <span className="connection-icon"><Icon aria-hidden="true" /></span>
            <span className={`connection-status ${copy.tone}`}><i />{copy.label}</span>
          </header>
          <div className="connection-title"><div><h2>{meta.name}</h2><span>{meta.role}</span></div></div>
          <p>{meta.description}</p>
          <div className="connection-card-footer">
            <CheckedAt value={item.last_checked_at} />
            {item.provider === "feishu" && item.needs_user_action && <button type="button" onClick={onReauthorizeFeishu}>前往飞书授权 <ExternalLink /></button>}
            {item.provider === "openmai" && item.needs_user_action && <span className="connection-guidance">请联系管理员开通</span>}
            {item.provider === "reloop" && <span className="connection-guidance">组织统一管理</span>}
          </div>
          {item.provider === "supermai" && <SupermaiActions item={item} busyPlatform={busyPlatform} onStart={onStartSupermai} />}
        </article>;
      })}
      {loading && items.length === 0 && [0, 1, 2, 3].map(index => <div className="connection-card connection-skeleton" key={index} aria-hidden="true"><i /><i /><i /></div>)}
    </div>

    <footer className="connection-trust-note">
      <ShieldCheck aria-hidden="true" />
      <div><b>授权边界</b><p>BrainX 只读取连接状态和授权结果，不接收第三方密码、短信验证码或浏览器 Cookie。</p></div>
    </footer>
  </div>;
}
