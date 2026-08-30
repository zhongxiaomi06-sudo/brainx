"use client";

import { useState, type ReactNode } from "react";
import {
  BriefcaseBusiness,
  ChevronUp,
  ClipboardCheck,
  Settings2,
  Sparkles,
  UserRound,
  Users,
  X,
} from "lucide-react";
import "./workspace-shell.css";

export type WorkspaceShellPage = "today" | "jobs" | "projects" | "clients" | "settings";

const primaryNavigation = [
  { id: "today", label: "今日决策", icon: Sparkles },
  { id: "jobs", label: "全部职位", icon: BriefcaseBusiness },
  { id: "projects", label: "我的项目", icon: ClipboardCheck },
  { id: "clients", label: "客户洞察", icon: Users },
] as const;

const pageMeta: Record<WorkspaceShellPage, { title: string; description: string }> = {
  today: { title: "今日决策", description: "先判断，再加入项目或开始跟进" },
  jobs: { title: "全部职位", description: "检索和核验 TTC 真实职位事实" },
  projects: { title: "我的项目", description: "查看项目状态并推进下一行动" },
  clients: { title: "客户洞察", description: "按客户查看可核验的职位事实" },
  settings: { title: "设置中心", description: "管理身份、数据连接、推荐策略与同步诊断" },
};

type WorkspaceShellProps = {
  activePage: WorkspaceShellPage;
  onNavigate: (page: WorkspaceShellPage) => void;
  consultant?: string;
  role?: string;
  assistantOpen?: boolean;
  onAssistantToggle?: () => void;
  assistant?: ReactNode;
  assistantPlacement?: "shell" | "overlay";
  children: ReactNode;
};

export function WorkspaceShell({
  activePage,
  onNavigate,
  consultant = "Mia 钟笑咪",
  role = "Consultant",
  assistantOpen = false,
  onAssistantToggle,
  assistant,
  assistantPlacement = "shell",
  children,
}: WorkspaceShellProps) {
  const meta = pageMeta[activePage];
  const initial = consultant.trim().slice(0, 1) || "M";
  const [accountOpen, setAccountOpen] = useState(false);

  return (
    <div className={`workspace-shell${assistantOpen && assistantPlacement === "shell" ? " assistant-is-open" : ""}`}>
      <aside className="workspace-sidebar" aria-label="主要导航">
        <button
          className="workspace-brand"
          type="button"
          onClick={() => onNavigate("today")}
          aria-label="返回今日决策"
        >
          <span className="workspace-brand-logo" aria-hidden="true" />
        </button>

        <nav className="workspace-primary-nav" aria-label="日常工作">
          {primaryNavigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={activePage === id ? "active" : ""}
              aria-label={label}
              aria-current={activePage === id ? "page" : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="workspace-account-anchor">
          {accountOpen && <div className="workspace-account-menu" role="menu">
            <header><span className="workspace-avatar" aria-hidden="true">{initial}</span><span><b>{consultant}</b><small>{role}</small></span></header>
            <button type="button" role="menuitem" onClick={() => { setAccountOpen(false); onNavigate("settings"); }}><UserRound /><span>个人资料</span></button>
            <button type="button" role="menuitem" onClick={() => { setAccountOpen(false); onNavigate("settings"); }}><Settings2 /><span>工作台设置</span></button>
          </div>}
          <button className="workspace-account-entry" type="button" aria-label="用户与设置" aria-expanded={accountOpen} onClick={() => setAccountOpen(open => !open)}>
            <span className="workspace-avatar" aria-hidden="true">{initial}</span>
            <span className="workspace-account-entry-copy"><b>{consultant}</b><small>{role}</small></span>
            <ChevronUp aria-hidden="true" />
          </button>
        </div>
      </aside>

      <section className="workspace-stage">
        <header className="workspace-topbar">
          <div className="workspace-page-identity">
            <span>BrainX · {meta.title}</span>
            <small>{meta.description}</small>
          </div>
          <button
            className={`workspace-assistant-trigger${assistantOpen ? " active" : ""}`}
            type="button"
            aria-expanded={assistantOpen}
            onClick={onAssistantToggle}
          >
            <Sparkles aria-hidden="true" />
            <span>BrainX 助手</span>
          </button>
        </header>
        <main className="workspace-content">{children}</main>
      </section>

      {assistantOpen && assistantPlacement === "shell" && (
        <aside className="workspace-assistant" aria-label="BrainX 助手面板">
          <header>
            <div><small>CONTEXT ASSISTANT</small><b>BrainX 助手</b></div>
            <button type="button" onClick={onAssistantToggle} aria-label="关闭 BrainX 助手"><X /></button>
          </header>
          {assistant}
        </aside>
      )}
    </div>
  );
}
