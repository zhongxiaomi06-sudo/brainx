import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { seedSync } from "../decision-demo";
import { decisionJobs } from "../workbench-model";
import { TodayDecisionQueue } from "../workbench-today";

const open = fn();
const nextPage = fn();
const searchQueue = fn();

const meta = {
  title: "业务组件/今日决策队列",
  component: TodayDecisionQueue,
  args: {
    activeJobId: null,
    completed: [],
    jobs: [],
    projects: [],
    engagement: {},
    sync: seedSync,
    open,
    onAction: fn(),
    onAddToProjects: fn(),
    onGoToProject: fn(),
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
    jobs: [{ ...decisionJobs[0], brainxLegal: ["WATCH", "ACCEPT", "DISMISS"], facts: {
      ...decisionJobs[0].facts,
      "决策层级": "TODAY", "决策层级原因": "已有明确下一步",
      "事实可信度": "SUFFICIENT", "事实可信度规则": "data-confidence-1.0",
      "事实更新时间": "2026-08-29T08:00:00Z", "最近活动": "业务群活动",
      "最近活动时间": "2026-08-29T07:30:00Z", "最近活动来源": "FEISHU_CHAT",
    } }],
    pagination: {
      pageIndex: 0, totalCount: 45, evaluatedCount: 5313, runId: "run-formal-1",
      generatedAt: "2026-08-29T08:00:00Z", policyVersion: "baseline-1.1",
      loading: false, error: null, newRunAvailable: false,
      searchQuery: "", onSearch: searchQueue,
      onPrevious: fn(), onNext: nextPage, onRefreshRun: fn(),
    },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("TODAY'S DECISIONS")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "今天只处理最值得推进的职位" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "推荐队列" })).toBeInTheDocument();
    await expect(canvas.getByText("参与计算 5313 · 已显示 1–1 / 45")).toBeInTheDocument();
    await expect(canvas.getByLabelText("今天推进，3格信号")).toBeInTheDocument();
    await expect(canvas.getByText("事实充分")).toBeInTheDocument();
    await expect(canvas.getByText("业务群活动 · 08/29")).toBeInTheDocument();
    const search = canvas.getByRole("textbox", { name: "搜索职位或公司" });
    await expect(search).toHaveAttribute("placeholder", "搜索完整队列：职位 / 公司 / JD");
    await userEvent.type(search, "A");
    await expect(searchQueue).toHaveBeenCalledWith("A");
    const card = canvas.getByRole("article", { name: `${decisionJobs[0].role} · ${decisionJobs[0].company}` });
    await expect(card).toHaveAttribute("tabindex", "0");
    await expect(Array.from(card.querySelectorAll(".recommendation-v2-actions button"), button => button.textContent?.trim()))
      .toEqual(["暂不考虑", "观察", "加入我的项目"]);
    await userEvent.click(canvas.getByRole("button", { name: "加入我的项目" }));
    await expect(args.onAddToProjects).toHaveBeenCalledWith(expect.objectContaining({ id: decisionJobs[0].id }));
    await userEvent.click(card);
    await expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: decisionJobs[0].id }), "judgement");
    await userEvent.click(canvas.getByRole("button", { name: "下一页 · 20 条" }));
    await expect(nextPage).toHaveBeenCalledOnce();
  },
};
