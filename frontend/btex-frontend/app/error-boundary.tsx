"use client";

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/** 工作台根错误边界：渲染异常时显示可恢复的降级界面，而不是整页白屏。 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
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
        </div>
      </div>
    );
  }
}
