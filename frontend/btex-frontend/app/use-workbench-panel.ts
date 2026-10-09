import { useEffect, useRef, useState } from "react";
import type { EngagementCommand } from "./decision-demo";
import type { DecisionJob, Panel } from "./workbench-model";

export type PendingCommand = { job: DecisionJob; command: EngagementCommand } | null;

export type PanelMotion = "idle" | "entering" | "open" | "closing";

// 面板开合动效与 Escape 关闭：纯 UI 状态机，从工作台主组件原样搬出。
export function useWorkbenchPanel(setPendingCommand: (value: PendingCommand) => void) {
  const [panel, setPanel] = useState<Panel>(null);
  const [panelMotion, setPanelMotion] = useState<PanelMotion>("idle");
  const panelAnimationFrame = useRef<number | null>(null);
  const panelCloseTimer = useRef<number | null>(null);
  const clearPanelMotion = () => {
    if (typeof window === "undefined") return;
    if (panelAnimationFrame.current !== null) {
      window.cancelAnimationFrame(panelAnimationFrame.current);
      panelAnimationFrame.current = null;
    }
    if (panelCloseTimer.current !== null) {
      window.clearTimeout(panelCloseTimer.current);
      panelCloseTimer.current = null;
    }
  };
  const dismissPanelImmediately = () => {
    clearPanelMotion();
    setPanel(null);
    setPanelMotion("idle");
  };
  const openPanel = (next: Panel) => {
    if (!next) return;
    clearPanelMotion();
    if (panel && panelMotion === "open") {
      setPanel(next);
      return;
    }
    const animate = typeof window !== "undefined" && window.matchMedia("(min-width: 961px)").matches;
    if (panelMotion === "closing") {
      setPanel(next);
      setPanelMotion("open");
      return;
    }
    setPanel(next);
    if (!animate) {
      setPanelMotion("open");
      return;
    }
    setPanelMotion("entering");
    panelAnimationFrame.current = window.requestAnimationFrame(() => {
      panelAnimationFrame.current = window.requestAnimationFrame(() => {
        setPanelMotion("open");
        panelAnimationFrame.current = null;
      });
    });
  };
  const closePanel = () => {
    if (!panel) return;
    clearPanelMotion();
    const animate = typeof window !== "undefined" && window.matchMedia("(min-width: 961px)").matches;
    if (!animate) {
      dismissPanelImmediately();
      return;
    }
    setPanelMotion("closing");
    panelCloseTimer.current = window.setTimeout(() => {
      setPanel(null);
      setPanelMotion("idle");
      panelCloseTimer.current = null;
    }, 380);
  };
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closePanel();
      setPendingCommand(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [panel, panelMotion]);
  useEffect(() => () => clearPanelMotion(), []);
  return { panel, panelMotion, openPanel, closePanel, dismissPanelImmediately };
}
