import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { seedSync } from "../decision-demo";
import { decisionJobs } from "../workbench-model";
import { TodayDecisionQueue } from "../workbench-today";

const open = fn();

const meta = {
  title: "业务组件/今日决策队列",
  component: TodayDecisionQueue,
  args: {
    activeJobId: null,
    completed: [],
    jobs: [],
    engagement: {},
    sync: seedSync,
    open,
    onAction: fn(),
    onFeedback: fn(),
    tray: [],
    onToggleTray: fn(),
    onRemoveTray: fn(),
    folders: [],
    folderMode: false,
    onFolderMode: fn(),
    onAssignFolder: fn(),
    onCreateFolder: fn(),
    onOpenSources: fn(),
  },
  decorators: [(Story) => <div style={{ padding: 24, background: "#f4f6f7" }}><Story /></div>],
} satisfies Meta<typeof TodayDecisionQueue>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EmptyRealSource: Story = { args: { mode: "connected" } };

export const FormalV2CardIntegration: Story = {
  name: "正式入口复用 V2 卡片",
  args: {
    mode: "offline",
    showVerification: false,
    jobs: [{ ...decisionJobs[0], brainxLegal: ["WATCH", "ACCEPT", "DISMISS"] }],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvas.getByRole("article", { name: `${decisionJobs[0].role} · ${decisionJobs[0].company}` });
    await expect(card).toHaveAttribute("tabindex", "0");
    await expect(Array.from(card.querySelectorAll(".recommendation-v2-actions button"), button => button.textContent?.trim()))
      .toEqual(["暂不考虑", "观察", "加入我的项目"]);
    await userEvent.click(card);
    await expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: decisionJobs[0].id }), "judgement");
  },
};
