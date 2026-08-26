"use client";

import { useEffect, useState } from "react";
import { Database, Settings2 } from "lucide-react";
import { brainxFetch } from "./brainx-api";
import { sourceNames } from "./workbench-model";
import { Heading, StatusTag } from "./workbench-controls";

type Notify = (message: string, options?: {
  actions?: { label: string; onClick: () => void }[];
  input?: { placeholder: string; onSubmit: (text: string) => void };
}, duration?: number) => void;
type TalentHealth = {
  backend: string;
  connected: boolean;
  schema: string;
  degraded: string | null;
  config?: { host: string; database: string | null };
  hint: string;
};
type TtcStatus = {
  connected: boolean;
  ttc_user_name?: string;
  expires_at?: string;
  needs_reauth?: boolean;
  expiring_soon?: boolean;
};

function TalentBackendCard() {
  const [health, setHealth] = useState<TalentHealth | null>(null);
  const [state, setState] = useState<"loading" | "live" | "offline">("loading");

  useEffect(() => {
    let alive = true;
    void brainxFetch<TalentHealth>("/api/v1/talent/health")
      .then((next) => { if (alive) { setHealth(next); setState("live"); } })
      .catch(() => { if (alive) setState("offline"); });
    return () => { alive = false; };
  }, []);

  const isMysql = health?.backend === "mysql" && health.connected;
  const badge = state === "offline" ? "未连接" : isMysql ? "已连接" : "内存回退";
  return <section className="card talent-backend">
    <div className="source-head"><div className="source-icon"><Database /></div><span className={`supply-badge ${isMysql ? "ok" : "warn"}`}>{badge}</span></div>
    <h3>人才库（阿里云 RDS）</h3>
    {state === "loading" && <p>正在检测人才库连接…</p>}
    {state === "offline" && <p>人才库接口暂时不可用，请检查后端服务。</p>}
    {state === "live" && health && <><p>{health.hint}</p><dl className="backend-facts">
      <div><dt>当前后端</dt><dd className={isMysql ? "" : "unknown"}>{isMysql ? "MySQL 真库" : "内存回退"}</dd></div>
      <div><dt>连通性</dt><dd className={health.connected ? "" : "unknown"}>{health.connected ? "已连通" : "未连通"}</dd></div>
      <div><dt>建表状态</dt><dd>{health.schema}</dd></div>
      {health.config && <div><dt>目标库</dt><dd>{health.config.database || "—"} @ {health.config.host}</dd></div>}
      {health.degraded && <div><dt>诊断</dt><dd className="unknown">{health.degraded}</dd></div>}
    </dl></>}
  </section>;
}

function formatExpiry(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { hour12: false });
}

function TtcSourceCard({ notify }: { notify: Notify }) {
  const [status, setStatus] = useState<TtcStatus | null>(null);
  const [jwt, setJwt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void brainxFetch<TtcStatus>("/api/v1/ttc/connect")
      .then((next) => { if (alive) { setStatus(next); setError(""); } })
      .catch((cause: unknown) => { if (alive) setError(cause instanceof Error ? cause.message : "连接状态读取失败"); });
    return () => { alive = false; };
  }, []);

  const connect = async () => {
    const token = jwt.trim();
    if (!token) { setError("请粘贴 TTC 的 ottin-jwt-token-v2"); return; }
    setBusy(true); setError("");
    try {
      const next = await brainxFetch<TtcStatus>("/api/v1/ttc/connect", { method: "PUT", body: { jwt: token } });
      setStatus(next); setJwt("");
      notify("TTC 已连接，真实职位会在下一轮后台同步后出现", undefined, 4000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "TTC 连接失败");
    } finally { setBusy(false); }
  };

  const connected = !!status?.connected;
  return <section className="card talent-backend ttc-source">
    <div className="source-head"><div className="source-icon"><Database /></div><span className={`supply-badge ${connected ? "ok" : status ? "warn" : "risk"}`}>{connected ? "已连接" : status ? "未连接" : "检测中"}</span></div>
    <h3>TTC 职位系统</h3>
    <p>真实职位的权威来源。凭证只提交给本地 BrainX 后端并加密保存，页面不会回显。</p>
    {connected ? <dl className="backend-facts">
      <div><dt>TTC 用户</dt><dd>{status?.ttc_user_name || "已验证用户"}</dd></div>
      <div><dt>有效期至</dt><dd className={status?.expiring_soon ? "unknown" : ""}>{formatExpiry(status?.expires_at)}</dd></div>
      <div><dt>同步状态</dt><dd>后台自动同步</dd></div>
      <div><dt>职位展示</dt><dd>同步完成后自动刷新</dd></div>
    </dl> : <div className="ttc-connect-form">
      <label htmlFor="ttc-jwt">TTC 凭证（ottin-jwt-token-v2）</label>
      <input id="ttc-jwt" className="field" type="password" autoComplete="off" spellCheck={false} value={jwt} onChange={(event) => setJwt(event.target.value)} placeholder="在 TTC 登录后复制 token 值并粘贴到这里" />
      <button className="btn primary" type="button" disabled={busy || !jwt.trim()} onClick={() => void connect()}>{busy ? "正在验证…" : "连接 TTC 并恢复职位"}</button>
    </div>}
    {error && <p className="ttc-connect-error" role="alert">{error}</p>}
  </section>;
}

function Sources({ notify }: { notify: Notify }) {
  const demos = sourceNames.filter((name) => name !== "职位库");
  return <><Heading code="DATA SOURCES" title="数据源" desc="人才库与 TTC 使用真实接口；其他来源仍为演示占位。" /><div className="source-grid">
    <TalentBackendCard />
    <TtcSourceCard notify={notify} />
    {demos.map((name) => <section className="card source" key={name}>
      <div className="source-head"><div className="source-icon"><Database /></div><StatusTag s="演示" /></div>
      <h3>{name}</h3><p>演示状态 · 尚未接入 BrainX 数据源接口</p>
      <div className="completeness"><span>数据完整度</span><b>—</b></div>
      <div className="bar"><i style={{ width: "0%", background: "var(--orange)" }} /></div>
      <button className="btn" style={{ marginTop: 14 }} onClick={() => notify("数据源字段查看仍为演示交互，不会写入真实系统")}><Settings2 />查看字段</button>
    </section>)}
  </div></>;
}

export default Sources;
