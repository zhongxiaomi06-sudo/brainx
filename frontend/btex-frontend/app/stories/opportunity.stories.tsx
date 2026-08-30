import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { DecisionZone } from "../workbench-opportunity";
import {
  DEFAULT_FOLDERS,
  decisionJobs,
  type DecisionJob,
} from "../workbench-model";

const meta = {
  title: "业务组件/机会列表",
  component: DecisionZone,
  parameters: { layout: "fullscreen" },
  args: {
    tone: "pending",
    title: "值得优先验证",
    subtitle: "先确认关键事实，再决定是否投入",
    jobs: decisionJobs.slice(0, 2),
    isContext: false,
    completed: [],
    engagement: {},
    open: fn(),
    onAction: fn(),
    onFeedback: fn(),
    tray: [],
    onToggleTray: fn(),
    folderMode: false,
    folders: DEFAULT_FOLDERS,
    onAssignFolder: fn(),
    anchorId: "opportunity-list",
  },
} satisfies Meta<typeof DecisionZone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Recommendations: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getAllByRole("button", { name: "收藏职位" })[0]);
    await expect(args.onToggleTray).toHaveBeenCalledWith(args.jobs[0].id);
  },
};

export const SelectedAndCompleted: Story = {
  args: {
    tray: [decisionJobs[0].id],
    completed: [`${decisionJobs[0].id}:${decisionJobs[0].actions[0].id}`],
    engagement: { [decisionJobs[0].id]: "WATCHED" },
  },
};

export const Empty: Story = {
  args: { jobs: [] },
};

const noActionJob: DecisionJob = {
  ...decisionJobs[0],
  id: "STORY-NO-ACTION",
  actions: [],
  recommendation: "没有可执行动作时仍应正常渲染，并提供查看完整判断入口。",
};

export const NoActionsFallback: Story = {
  args: { jobs: [noActionJob] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: /完整判断/ })).toBeEnabled();
  },
};
