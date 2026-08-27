"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Database, LoaderCircle, LogIn, RefreshCw } from "lucide-react";
import { brainxFetch, type BackendConsultants, type BackendSessionStatus } from "./brainx-api";

export type WorkspaceEntryKind = "connecting" | "auth" | "unavailable";

type WorkspaceEntryProps = {
  kind: WorkspaceEntryKind;
  onRetry: () => void;
  onCheckConnection: () => Promise<void>;
  onOpenSources: () => void;
  sampleConsultants?: BackendConsultants["items"];
};

export function WorkspaceEntry({ kind, onRetry, onCheckConnection, onOpenSources, sampleConsultants }: WorkspaceEntryProps) {
  const [devAuth, setDevAuth] = useState(false);
  const [consultants, setConsultants] = useState<BackendConsultants["items"] | null>(sampleConsultants ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (kind !== "auth" || sampleConsultants) return;
    let active = true;
    void Promise.all([
      brainxFetch<BackendSessionStatus>("/api/v1/oauth/status"),
      brainxFetch<BackendConsultants>("/api/v1/consultants"),
    ]).then(([status, people]) => {
      if (!active) return;
      setDevAuth(status.dev_auth);
      setConsultants(people.items || []);
    }).catch(() => {
      if (active) setConsultants([]);
    });
    return () => { active = false; };
  }, [kind, sampleConsultants]);

  const devLogin = async (consultantId: string) => {
    setBusy(consultantId);
    setError("");
    try {
      await brainxFetch<null>("/api/v1/session", { method: "POST", body: { consultant_id: consultantId } });
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "登录失败，请稍后重试");
      setBusy(null);
    }
  };

  const checkConnection = async () => {
    setBusy("connection");
    setError("");
    try {
      await onCheckConnection();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "连接检查失败，请打开连接设置查看详情");
    } finally {
      setBusy(null);
    }
  };

  if (kind === "connecting") return <section className="workspace-entry is-loading" aria-live="polite">
    <span className="workspace-entry-icon"><LoaderCircle className="spin" /></span>
    <div><span className="eyebrow">正在建立工作区</span><h1>正在连接真实职位数据</h1><p>BrainX 正在确认你的身份、职位来源和最近一次同步结果。</p></div>
    <div className="entry-skeleton" aria-hidden="true"><i/><i/><i/></div>
  </section>;

  if (kind === "unavailable") return <section className="workspace-entry" aria-live="polite">
    <span className="workspace-entry-icon warning"><AlertTriangle /></span>
    <div><span className="eyebrow">连接暂时不可用</span><h1>真实职位数据还没有加载成功</h1><p>当前页面不会用演示数据冒充真实结果。你可以重试，或检查 TTC 职位系统与 BrainX 后端的连接。</p></div>
    <div className="workspace-entry-actions"><button className="btn primary" onClick={onRetry}><RefreshCw/>重新连接</button><button className="btn" disabled={busy === "connection"} onClick={() => void checkConnection()}>{busy === "connection" ? <LoaderCircle className="spin"/> : <Database/>}{busy === "connection" ? "检查中…" : "立即检查"}</button><button className="btn" onClick={onOpenSources}>打开连接设置</button></div>
    {error && <p className="entry-error">{error}</p>}
  </section>;

  return <section className="workspace-entry auth-entry" aria-live="polite">
    <span className="workspace-entry-icon"><LogIn /></span>
    <div><span className="eyebrow">需要登录</span><h1>登录后查看真实职位</h1><p>登录用于识别你能看到的职位、项目关系和推荐结果。BrainX 不会在未登录时展示虚构的职位数据。</p></div>
    <div className="workspace-entry-actions"><button className="btn primary" onClick={() => { window.location.href = "/api/v1/oauth/authorize"; }}>飞书扫码登录 <ArrowRight/></button><button className="btn" onClick={onRetry}><RefreshCw/>我已登录，重新检查</button></div>
    {(devAuth || sampleConsultants) && <div className="entry-dev-login"><small>本地开发快捷登录</small><div>{consultants === null ? <span>读取顾问列表…</span> : consultants.map(person => <button key={person.consultant_id} disabled={busy !== null} onClick={() => void devLogin(person.consultant_id)}>{busy === person.consultant_id ? "登录中…" : person.display_name}</button>)}</div></div>}
    {error && <p className="entry-error">{error}</p>}
  </section>;
}
