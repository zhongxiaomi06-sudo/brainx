import { BrainxApiError } from "./brainx-api";

export type AssistantMessage = { role: "user" | "assistant"; content: string };
export type AssistantContext = { page: string; opportunity_id?: string | null };
export type AssistantChatOptions = {
  question: string;
  history: AssistantMessage[];
  context: AssistantContext;
  signal?: AbortSignal;
};

/** 只读助手流式接口；直接消费 SSE，避免通用 JSON 客户端吞掉增量。 */
export async function streamAssistant(
  options: AssistantChatOptions,
  onText: (text: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  const res = await fetch("/api/v1/assistant/chat", {
    method: "POST",
    credentials: "same-origin",
    signal: options.signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json() as { error?: { message?: string } | string };
      message = typeof data.error === "string" ? data.error : data.error?.message || message;
    } catch { /* text fallback */ }
    throw new BrainxApiError(String(message), res.status);
  }
  if (!res.body) throw new BrainxApiError("助手没有返回内容", 502);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5).trim()) as { text?: string; message?: string };
          if (data.text) onText(data.text);
          if (data.message) onError(data.message);
        } catch { /* ignore malformed provider frame */ }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}
