"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** 工作台根错误边界：渲染异常时显示可恢复的降级界面，而不是整页白屏。
 *  捕获后自动上报 /api/v1/meta/client-error（与 layout.tsx 内联探针同通道，
 *  2026-08-25 mia 白屏事故防线）。 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
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
      <div
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          background: "#f5f7fb",
          fontFamily: "Inter, 'PingFang SC', system-ui, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: 420,
            padding: 32,
            borderRadius: 16,
            background: "#fff",
            border: "1px solid rgba(31,49,83,.12)",
          }}
        >
          <p style={{ margin: "0 0 8px", color: "#176B58", fontSize: 12, fontWeight: 700, letterSpacing: ".14em" }}>
            BRAIN X
          </p>
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>工作台遇到问题</h1>
          <p style={{ fontSize: 13, color: "#6c768c", lineHeight: 1.7, margin: 0 }}>
            页面渲染出现异常，请先重试；若反复出现，把下方信息发给管理员。
          </p>
          <pre
            style={{
              margin: "12px 0 0",
              padding: 10,
              background: "#f5f7fb",
              borderRadius: 8,
              fontSize: 12,
              overflow: "auto",
              maxHeight: 160,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {String(error.message || error)}
          </pre>
          <button
            type="button"
            style={{
              marginTop: 16,
              border: 0,
              borderRadius: 10,
              padding: "10px 16px",
              background: "#176B58",
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
            }}
            onClick={() => this.setState({ error: null })}
          >
            重试
          </button>
          <button
            type="button"
            style={{
              marginTop: 16,
              marginLeft: 8,
              border: "1px solid #d1d5db",
              borderRadius: 10,
              padding: "10px 16px",
              background: "#fff",
              color: "#374151",
              fontSize: 13,
              cursor: "pointer",
            }}
            onClick={() => { try { localStorage.removeItem("decision-workbench"); } catch { /* ignore */ } location.reload(); }}
          >
            清空本地缓存并刷新
          </button>
        </div>
      </div>
    );
  }
}
