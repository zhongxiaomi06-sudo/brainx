import type { Dispatch, SetStateAction } from "react";

export type CommitmentEditorMode = "accept" | "progress" | "blocked" | "terminal" | "release" | null;
export const releaseReasons = ["资源不足", "优先级调整", "转交其他顾问", "客户/职位变化", "当前无法投入", "其他"];
export const closeReasons = ["职位关闭", "HC 已满", "客户暂停", "需求取消", "其他"];
export const progressStages = ["推荐采纳", "面试", "Offer", "反馈"] as const;

type Setter<T> = Dispatch<SetStateAction<T>>;
type Props = {
  editor: Exclude<CommitmentEditorMode, null>;
  setEditor: Setter<CommitmentEditorMode>;
  step: 1 | 2;
  setStep: Setter<1 | 2>;
  busy: boolean;
  error: string;
  setError: Setter<string>;
  goal: string;
  setGoal: Setter<string>;
  actionTitle: string;
  setActionTitle: Setter<string>;
  dueAt: string;
  setDueAt: Setter<string>;
  summary: string;
  setSummary: Setter<string>;
  stage: (typeof progressStages)[number];
  setStage: Setter<(typeof progressStages)[number]>;
  rating: number;
  setRating: Setter<number>;
  nextTitle: string;
  setNextTitle: Setter<string>;
  nextDue: string;
  setNextDue: Setter<string>;
  setNextSource: Setter<"RULE" | "MANUAL">;
  terminalStage: "入职" | "关闭";
  setTerminalStage: Setter<"入职" | "关闭">;
  closeReason: string;
  setCloseReason: Setter<string>;
  releaseReason: string;
  setReleaseReason: Setter<string>;
  submitAccept: () => void;
  buildSuggestion: () => void;
  submitProgress: () => void;
  submitTerminal: () => void;
  submitRelease: () => void;
  deadlineButtons: (set: (value: string) => void) => React.ReactNode;
};

export function CommitmentEditor(props: Props) {
  const {
    editor, setEditor, step, setStep, busy, error, setError, goal, setGoal,
    actionTitle, setActionTitle, dueAt, setDueAt, summary, setSummary, stage,
    setStage, rating, setRating, nextTitle, setNextTitle, nextDue, setNextDue,
    setNextSource, terminalStage, setTerminalStage, closeReason, setCloseReason,
    releaseReason, setReleaseReason, submitAccept, buildSuggestion, submitProgress,
    submitTerminal, submitRelease, deadlineButtons,
  } = props;
  const title = editor === "accept" ? "建立承接"
    : editor === "progress" ? (step === 1 ? "填写本次结果" : "确认下一行动")
    : editor === "blocked" ? (step === 1 ? "记录阻塞" : "确认下一行动")
    : editor === "terminal" ? "记录终局结果" : "释放承接";
  return <section className="commitment-editor">
    <div className="commitment-editor-head"><h2>{title}</h2><button aria-label="关闭编辑" onClick={() => { setEditor(null); setError(""); }}>×</button></div>
    {editor === "accept" && <div className="commitment-fields">
      <label>本轮目标<textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="例如：两周内确认至少 2 位候选人的面试结果" /></label>
      <label>第一条行动<input value={actionTitle} onChange={(event) => setActionTitle(event.target.value)} placeholder="下一步具体做什么" /></label>
      <label>截止时间<input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      {deadlineButtons(setDueAt)}
      <button className="primary" disabled={busy} onClick={submitAccept}>{busy ? "保存中…" : "确认接单并建立行动"}</button>
    </div>}
    {(editor === "progress" || editor === "blocked") && step === 1 && <div className="commitment-fields">
      <label>本次结果<textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder={editor === "blocked" ? "卡在哪里、已做过什么" : "发生了什么、得到什么结论"} /></label>
      {editor === "progress" && <>
        <label>结果标签<select value={stage} onChange={(event) => setStage(event.target.value as typeof stage)}>{progressStages.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label>结果质量<input type="range" min="1" max="5" value={rating} onChange={(event) => setRating(Number(event.target.value))} /><span>{rating} / 5</span></label>
      </>}
      <button className="primary" disabled={busy} onClick={buildSuggestion}>{busy ? "生成中…" : "生成下一行动建议"}</button>
    </div>}
    {(editor === "progress" || editor === "blocked") && step === 2 && <div className="commitment-fields">
      <label>下一行动<input value={nextTitle} onChange={(event) => { setNextTitle(event.target.value); setNextSource("MANUAL"); }} /></label>
      <label>截止时间<input type="datetime-local" value={nextDue} onChange={(event) => setNextDue(event.target.value)} /></label>
      {deadlineButtons(setNextDue)}
      <div className="commitment-editor-actions"><button onClick={() => setStep(1)}>返回修改结果</button><button className="primary" disabled={busy} onClick={submitProgress}>{busy ? "提交中…" : "确认结果与下一行动"}</button></div>
    </div>}
    {editor === "terminal" && <div className="commitment-fields">
      <label>终局结果<div className="commitment-terminal-options" role="group" aria-label="终局结果">
        <button type="button" className={terminalStage === "入职" ? "selected" : ""} aria-pressed={terminalStage === "入职"} onClick={() => setTerminalStage("入职")}>入职</button>
        <button type="button" className={terminalStage === "关闭" ? "selected" : ""} aria-pressed={terminalStage === "关闭"} onClick={() => setTerminalStage("关闭")}>关闭</button>
      </div></label>
      {terminalStage === "关闭" && <label>关闭原因<select value={closeReason} onChange={(event) => setCloseReason(event.target.value)}>{closeReasons.map((value) => <option key={value}>{value}</option>)}</select></label>}
      <label>结果摘要<textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="记录最终发生了什么，以及必要的上下文" /></label>
      <button className="primary" disabled={busy} onClick={submitTerminal}>{busy ? "提交中…" : "确认终局并完成承接"}</button>
    </div>}
    {editor === "release" && <div className="commitment-fields">
      <label>释放原因<select value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)}>{releaseReasons.map((value) => <option key={value}>{value}</option>)}</select></label>
      <label>说明<textarea value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="为什么释放、后续由谁或何时再看" /></label>
      <button className="danger" disabled={busy} onClick={submitRelease}>{busy ? "提交中…" : "确认释放并取消当前行动"}</button>
    </div>}
    {error && <p className="commitment-error">{error}</p>}
  </section>;
}
