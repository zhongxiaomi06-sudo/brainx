import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { DinoRunner } from "../dino-runner";
import { CommitmentLoopPanel } from "../engagement-loop";
import { ManualFactSection } from "../workbench-facts";
import { decisionJobs } from "../workbench-model";

const meta = {
  title: "业务组件/辅助流程",
  parameters: { surfaceClass: "storybook-compact" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const job = decisionJobs[0];
const noOpAsync = async () => undefined;

export const Facts: Story = {
  render: () => (
    <div className="storybook-panel">
      <ManualFactSection
        job={job}
        mode="offline"
        onUpdated={noOpAsync}
        notify={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "编辑" }));
    await expect(canvas.getByRole("button", { name: "保存并重新判断" })).toBeInTheDocument();
  },
};

export const FactsConnecting: Story = {
  render: () => (
    <div className="storybook-panel">
      <ManualFactSection
        job={job}
        mode="connecting"
        onUpdated={noOpAsync}
        notify={() => undefined}
      />
    </div>
  ),
};

function Loop({ state }: { state: "RECOMMENDED" | "ACCEPTED" }) {
  return (
    <CommitmentLoopPanel
      job={{ ...job, facts: { ...job.facts, 职位关系: "我的职位" } }}
      state={state}
      outcomes={[]}
      mode="offline"
      legal={state === "RECOMMENDED" ? ["WATCH", "ACCEPT", "DISMISS"] : ["RELEASE", "COMPLETE"]}
      onCommand={() => undefined}
      onMembership={noOpAsync}
      onVerify={() => undefined}
      onUpdated={noOpAsync}
      notify={() => undefined}
    />
  );
}

export const CommitmentReady: Story = {
  render: () => <Loop state="RECOMMENDED" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const timeline = canvas.getByRole("heading", { name: "行动与结果" });
    const start = canvas.getByRole("button", { name: "开始跟进" });
    await expect(canvas.queryByRole("heading", { name: "项目跟进" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "加入关注" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "暂不考虑" })).toBeInTheDocument();
    await expect(Boolean(timeline.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  },
};

export const CommitmentAccepted: Story = {
  render: () => <Loop state="ACCEPTED" />,
};

export const DinoGame: Story = {
  render: () => <DinoRunner />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "点击或按空格开始" }));
    await expect(canvas.getByRole("button", { name: "点击或按空格跳跃" })).toBeInTheDocument();
  },
};
