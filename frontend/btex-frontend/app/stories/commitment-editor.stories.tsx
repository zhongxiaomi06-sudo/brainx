import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  CommitmentEditor,
  type CommitmentEditorMode,
  progressStages,
} from "../engagement-loop-editor";

const meta = {
  title: "流程组件/项目跟进编辑器",
  parameters: {
    surfaceClass: "storybook-compact",
    docs: {
      description: {
        component: "使用本地状态驱动真实 CommitmentEditor，集中展示开始跟进、进展、阻塞、终局和释放。",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type HarnessProps = {
  initialEditor: Exclude<CommitmentEditorMode, null>;
  initialStep?: 1 | 2;
  initialTerminalStage?: "入职" | "关闭";
  busy?: boolean;
  error?: string;
};

function EditorHarness({
  initialEditor,
  initialStep = 1,
  initialTerminalStage = "入职",
  busy = false,
  error: initialError = "",
}: HarnessProps) {
  const [editor, setEditor] = useState<CommitmentEditorMode>(initialEditor);
  const [step, setStep] = useState<1 | 2>(initialStep);
  const [error, setError] = useState(initialError);
  const [goal, setGoal] = useState("两周内确认两位候选人的面试结果");
  const [actionTitle, setActionTitle] = useState("联系客户确认最新反馈");
  const [dueAt, setDueAt] = useState("2026-08-28T18:00");
  const [summary, setSummary] = useState("客户确认职位仍在推进");
  const [stage, setStage] = useState<(typeof progressStages)[number]>("反馈");
  const [rating, setRating] = useState(4);
  const [nextTitle, setNextTitle] = useState("补充两位候选人并回写进展");
  const [nextDue, setNextDue] = useState("2026-08-29T18:00");
  const [, setNextSource] = useState<"RULE" | "MANUAL">("RULE");
  const [terminalStage, setTerminalStage] = useState<"入职" | "关闭">(initialTerminalStage);
  const [closeReason, setCloseReason] = useState("职位关闭");
  const [releaseReason, setReleaseReason] = useState("优先级调整");

  if (!editor) return <p>编辑器已关闭</p>;
  const deadlineButtons = (set: (value: string) => void) => (
    <div className="commitment-deadlines">
      <button type="button" onClick={() => set("2026-08-28T18:00")}>明天</button>
      <button type="button" onClick={() => set("2026-08-30T18:00")}>三天后</button>
    </div>
  );
  return (
    <CommitmentEditor
      editor={editor}
      setEditor={setEditor}
      step={step}
      setStep={setStep}
      busy={busy}
      error={error}
      setError={setError}
      goal={goal}
      setGoal={setGoal}
      actionTitle={actionTitle}
      setActionTitle={setActionTitle}
      dueAt={dueAt}
      setDueAt={setDueAt}
      summary={summary}
      setSummary={setSummary}
      stage={stage}
      setStage={setStage}
      rating={rating}
      setRating={setRating}
      nextTitle={nextTitle}
      setNextTitle={setNextTitle}
      nextDue={nextDue}
      setNextDue={setNextDue}
      setNextSource={setNextSource}
      terminalStage={terminalStage}
      setTerminalStage={setTerminalStage}
      closeReason={closeReason}
      setCloseReason={setCloseReason}
      releaseReason={releaseReason}
      setReleaseReason={setReleaseReason}
      submitAccept={() => undefined}
      buildSuggestion={() => setStep(2)}
      submitProgress={() => undefined}
      submitTerminal={() => undefined}
      submitRelease={() => undefined}
      deadlineButtons={deadlineButtons}
    />
  );
}

export const Accept: Story = {
  render: () => <EditorHarness initialEditor="accept" />,
};

export const ProgressResult: Story = {
  render: () => <EditorHarness initialEditor="progress" />,
};

export const ProgressNextAction: Story = {
  render: () => <EditorHarness initialEditor="progress" initialStep={2} />,
};

export const Blocked: Story = {
  render: () => <EditorHarness initialEditor="blocked" />,
};

export const TerminalClosed: Story = {
  render: () => <EditorHarness initialEditor="terminal" initialTerminalStage="关闭" />,
};

export const Release: Story = {
  render: () => <EditorHarness initialEditor="release" />,
};

export const BusyWithError: Story = {
  render: () => (
    <EditorHarness
      initialEditor="accept"
      busy
      error="目标、第一行动和截止时间必须完整填写。"
    />
  ),
};
