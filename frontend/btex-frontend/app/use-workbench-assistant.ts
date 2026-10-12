import { useEffect, useRef, useState } from "react";
import { streamAssistant, type AssistantMessage, type AssistantToolEvent } from "./brainx-assistant-api";
import type { Page } from "./workbench-model";

// BrainX 助手会话：消息流、历史持久化与中断，从工作台主组件原样搬出。
export function useWorkbenchAssistant({ page, contextJobId }: { page: Page; contextJobId: string | null }) {
  const [assistantOpen, setAssistantOpen] = useState(false);
  // 历史记录用惰性初始化读入：抽屉默认关闭不参与首帧渲染，SSR/水合无差异
  const [assistantMessages, setAssistantMessages] = useState<AssistantMessage[]>(() => {
    try {
      const saved = localStorage.getItem("brainx-assistant-history");
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [assistantInput, setAssistantInput] = useState("");
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantSettings, setAssistantSettings] = useState(false);
  const [assistantTool, setAssistantTool] = useState<string | null>(null);
  const assistantAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem("brainx-assistant-history", JSON.stringify(assistantMessages.slice(-40)));
    } catch {}
  }, [assistantMessages]);
  useEffect(() => () => assistantAbort.current?.abort(), []);
  const sendAssistant = () => {
    const question = assistantInput.trim();
    if (!question || assistantBusy) return;
    const user: AssistantMessage = { role: "user", content: question };
    const controller = new AbortController();
    assistantAbort.current = controller;
    setAssistantInput("");
    setAssistantBusy(true);
    setAssistantTool(null);
    setAssistantMessages((current) => [...current, user, { role: "assistant", content: "" }]);
    void streamAssistant(
      {
        question,
        history: assistantMessages.slice(-12),
        context: { page, opportunity_id: contextJobId },
        signal: controller.signal,
      },
      (text) =>
        setAssistantMessages((current) => {
          const next = [...current];
          const last = next.length - 1;
          if (last >= 0 && next[last].role === "assistant")
            next[last] = { ...next[last], content: next[last].content + text };
          return next;
        }),
      (message) =>
        setAssistantMessages((current) => {
          const next = [...current];
          const last = next.length - 1;
          if (last >= 0 && next[last].role === "assistant") next[last] = { ...next[last], content: message };
          return next;
        }),
      (event: AssistantToolEvent) => {
        if (event.status === "start") setAssistantTool(event.tool);
      },
    )
      .catch((error) => {
        if (error?.name !== "AbortError")
          setAssistantMessages((current) => {
            const next = [...current];
            const last = next.length - 1;
            if (last >= 0 && next[last].role === "assistant")
              next[last] = {
                ...next[last],
                content: `助手暂不可用：${error instanceof Error ? error.message : "后端未响应"}`,
              };
            return next;
          });
      })
      .finally(() => {
        assistantAbort.current = null;
        setAssistantBusy(false);
        setAssistantTool(null);
      });
  };
  return {
    assistantOpen,
    setAssistantOpen,
    assistantMessages,
    setAssistantMessages,
    assistantInput,
    setAssistantInput,
    assistantBusy,
    assistantSettings,
    setAssistantSettings,
    assistantTool,
    assistantAbort,
    sendAssistant,
  };
}
