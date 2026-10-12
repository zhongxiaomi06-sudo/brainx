import { useEffect, useRef } from "react";
import { Send, Settings2, Sparkles, X } from "lucide-react";
import type { AssistantMessage } from "./brainx-assistant-api";
import type { DecisionJob } from "./workbench-model";
import { MarkdownBody } from "./openmai-markdown";

function ChatbotDrawer({
  messages,
  input,
  setInput,
  busy,
  tool,
  onSend,
  onStop,
  onClear,
  onClose,
  mode,
  settings,
  setSettings,
  contextJob,
}: {
  messages: AssistantMessage[];
  input: string;
  setInput: (value: string) => void;
  busy: boolean;
  tool: string | null;
  onSend: () => void;
  onStop: () => void;
  onClear: () => void;
  onClose: () => void;
  mode: "connecting" | "connected" | "offline";
  settings: boolean;
  setSettings: (value: boolean) => void;
  contextJob: DecisionJob | null;
}) {
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy, tool]); // 新内容/工具活动变化滚到底,agent 回答长不滚看不到新文本
  const contextLabel = contextJob ? `${contextJob.company} · ${contextJob.role}` : null;

  return (
    <>
      <div className="assistant-backdrop" onClick={onClose} />
      <aside className="assistant-drawer" aria-label="BrainX 助手">
        <header>
          <div className="assistant-heading">
            <span className="assistant-heading-icon">
              <Sparkles />
            </span>
            <div>
              <h2>BrainX 助手</h2>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭助手">
            <X />
          </button>
        </header>
        {settings && (
          <div className="assistant-settings">
            <div className="assistant-settings-title">
              <b>模型服务</b>
              <button className="icon-btn" onClick={() => setSettings(false)} aria-label="关闭设置">
                <X />
              </button>
            </div>
            <small>模型和密钥由 BrainX 服务器统一配置，浏览器不会读取或保存供应商密钥。</small>
          </div>
        )}
        <div className="assistant-messages" aria-live="polite" ref={messagesRef}>
          {messages.length === 0 ? (
            <div className="assistant-empty">
              {contextLabel ? (
                <>
                  当前上下文：{contextLabel}
                  <br />向 BrainX 助手提问，获取当前职位的判断建议。
                </>
              ) : (
                "向 BrainX 助手提问，获取当前职位或工作台的判断建议。"
              )}
            </div>
          ) : (
            messages.map((message, index) => (
              <div className={`assistant-message ${message.role}`} key={`${index}-${message.role}`}>
                <span>{message.role === "user" ? "你" : "BrainX"}</span>
                {message.role === "assistant" && message.content ? (
                  <MarkdownBody text={message.content} className="assistant-md" />
                ) : (
                  <p>
                    {message.content ||
                      (busy && index === messages.length - 1
                        ? tool
                          ? "正在查询相关资料…"
                          : "正在思考…"
                        : "")}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
        <form
          className="assistant-compose"
          onSubmit={(event) => {
            event.preventDefault();
            onSend();
          }}
        >
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="向 BrainX 助手提问…"
            rows={2}
            disabled={busy && mode !== "connected"}
          />
          <div>
            <button type="button" className="assistant-clear" onClick={onClear}>
              清空
            </button>
            <button
              type="button"
              className="assistant-gear"
              onClick={() => setSettings(!settings)}
              aria-label="模型设置"
            >
              <Settings2 />
            </button>
            {busy ? (
              <button type="button" className="btn" onClick={onStop}>
                停止
              </button>
            ) : (
              <button type="submit" className="btn primary" disabled={!input.trim() || mode !== "connected"}>
                <Send />
                发送
              </button>
            )}
          </div>
        </form>
      </aside>
    </>
  );
}


export { ChatbotDrawer };
