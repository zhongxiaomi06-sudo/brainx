"use client";

import { Component, type ReactNode } from "react";

/** 全局错误边界：任何渲染异常兜底为可恢复的出错页，而不是整树卸载白屏。
 *  2026-08-25 mia 账号白屏事故（DecisionCard actions 空数组）的系统性防线。
 *  捕获后自动上报 /api/v1/meta/client-error（与 layout.tsx 内联探针同通道）。 */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    try {
      const payload = JSON.stringify({
        kind: "react-boundary",
        message: String(error.message || error).slice(0, 500),
        source: "ErrorBoundary",
        stack: String(error.stack || "").slice(0, 1000),
        url: location.pathname + location.search,
        chunk: /dynamically imported module|Loading chunk|ChunkLoadError/.test(String(error.message || "")),
        component_stack: String(info.componentStack || "").slice(0, 1000),
      });
      navigator.sendBeacon("/api/v1/meta/client-error", new Blob([payload], { type: "application/json" }));
    } catch { /* 监控自身永不影响页面 */ }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "inherit" }}>
        <div style={{ maxWidth: 480, textAlign: "center", border: "1px solid #e5e7eb", borderRadius: 16, padding: "40px 32px", boxShadow: "0 8px 30px rgba(0,0,0,.06)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>页面出现异常，已自动上报</h1>
          <p style={{ fontSize: 13, color: "#6b7280", margin: "0 0 20px", wordBreak: "break-all" }}>
            {String(error.message || error).slice(0, 200)}
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button
              onClick={() => location.reload()}
              style={{ padding: "10px 20px", borderRadius: 10, border: 0, background: "#176B58", color: "#fff", fontWeight: 700, cursor: "pointer" }}
            >
              重新加载
            </button>
            <button
              onClick={() => { try { localStorage.removeItem("decision-workbench"); } catch { /* ignore */ } location.reload(); }}
              style={{ padding: "10px 20px", borderRadius: 10, border: "1px solid #d1d5db", background: "#fff", color: "#374151", cursor: "pointer" }}
            >
              清空本地缓存并刷新
            </button>
          </div>
        </div>
      </div>
    );
  }
}
