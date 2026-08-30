import { useState, type ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  RecommendationQueueV2Review,
  type RecommendationQueueItem,
} from "../recommendation-queue-v2-review";

const open = fn();
const action: ComponentProps<typeof RecommendationQueueV2Review>["onAction"] = fn(async () => {});
const refreshRun = fn();

function itemAt(index: number): RecommendationQueueItem {
  const rank = index + 1;
  const tier = rank <= 7 ? "TODAY" : rank <= 28 ? "WEEK" : "VERIFY";
  return {
    projectId: `J-REVIEW-${String(rank).padStart(3, "0")}`,
    rank,
    tier,
    role: rank % 3 === 0 ? "AI 产品负责人" : rank % 3 === 1 ? "高级算法工程师" : "海外增长负责人",
    company: `脱敏客户 ${String.fromCharCode(65 + index % 8)}`,
    cities: rank % 4 === 0 ? ["北京市", "上海市"] : [rank % 2 ? "上海市" : "北京市"],
    relation: rank % 5 === 0 ? "团队共享" : "未加入",
    activeState: "招聘中",
    hc: rank % 6 === 0 ? null : rank % 4 + 1,
    currentStage: rank % 3 === 0 ? "面试" : "寻访",
    recentActivity: { label: rank % 3 === 0 ? "新增面试" : "职位事实更新", occurredAt: "2026-08-28T09:00:00+08:00" },
    pipeline: rank % 3 === 0 ? "推荐 8 · 面试 2" : "寻访 12 · 推荐 3",
    score: 96 - rank / 2,
    evidenceCoverage: rank % 6 === 0 ? 68 : 92,
    explorationScore: rank % 5 === 0 ? 100 : 50,
    reasons: [
      { code: "NEXT_ACTION_READY", text: "存在明确的下一步动作，可以直接开始推进。", evidence: "驾驶舱下一动作", occurredAt: "2026-08-28T09:00:00+08:00" },
      { code: "PIPELINE_RECENT", text: "近期 Pipeline 有可核验的真实变化。", evidence: "TTC Pipeline 快照", occurredAt: "2026-08-27T15:20:00+08:00" },
    ],
    risk: rank % 6 === 0 ? "剩余 HC 尚未确认，开始跟进前需要核验。" : null,
    confidence: rank > 28 ? "INSUFFICIENT" : rank % 6 === 0 ? "PARTIAL" : "SUFFICIENT",
    factsUpdatedAt: "2026-08-28T09:00:00+08:00",
    engagementLabel: null,
    legalActions: ["ADD", "WATCH", "DISMISS"],
  };
}

const allItems = Array.from({ length: 45 }, (_, index) => itemAt(index));

const baseArgs = {
  items: allItems.slice(0, 20),
  pageIndex: 0,
  totalCount: allItems.length,
  evaluatedCount: 5313,
  runId: "run-review-20260828",
  generatedAt: "2026-08-28T09:10:00+08:00",
  policyVersion: "baseline-1.1",
  onOpen: open,
  onAction: action,
};

const meta = {
  title: "组合场景/推荐队列 V2 审核稿",
  component: RecommendationQueueV2Review,
  args: baseArgs,
  parameters: { layout: "fullscreen" },
  decorators: [(Story) => <div style={{ minHeight: "100vh", padding: 24, background: "#f5f8f7" }}><Story /></div>],
} satisfies Meta<typeof RecommendationQueueV2Review>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FirstPage: Story = {
  name: "首批 20 条与新版卡片",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("article")).toHaveLength(20);
    await expect(canvas.getByRole("heading", { name: "推荐队列" })).toBeInTheDocument();
    await expect(canvas.getByText("岗位数量：", { exact: false })).toHaveTextContent("45");
    await expect(canvas.getByText("更新时间：", { exact: false })).toHaveTextContent("08/28");
    await expect(canvas.queryByText("DECISION QUEUE · V2")).not.toBeInTheDocument();
    await expect(canvas.queryByText("为什么值得看")).not.toBeInTheDocument();
    await expect(canvas.queryByText("需要注意")).not.toBeInTheDocument();
    await expect(canvas.queryByLabelText("判断状态")).not.toBeInTheDocument();
    await expect(canvas.getAllByText("AI 匹配分")[0]).toBeInTheDocument();
    await expect(canvas.getAllByText("证据覆盖")[0]).toBeInTheDocument();
    await expect(canvas.getAllByText("探索价值")[0]).toBeInTheDocument();
    const firstCard = canvas.getByRole("article", { name: "高级算法工程师 · 脱敏客户 A" });
    await expect(within(firstCard).getByLabelText("今天推进，3格信号")).toBeInTheDocument();
    await expect(within(firstCard).queryByRole("button", { name: "查看 高级算法工程师 判断" })).not.toBeInTheDocument();
    await expect(Array.from(firstCard.querySelectorAll(".recommendation-v2-actions button"), button => button.textContent?.trim())).toEqual(["暂不考虑", "观察", "加入我的项目"]);
    firstCard.focus();
    await userEvent.keyboard("{Enter}");
    await expect(open).toHaveBeenCalledWith(expect.objectContaining({ projectId: "J-REVIEW-001" }));
    await userEvent.click(within(firstCard).getByRole("button", { name: "加入我的项目" }));
    await expect(action).toHaveBeenCalledWith(expect.objectContaining({ projectId: "J-REVIEW-001" }), "ADD");
    await expect(within(firstCard).queryByText("加入我的项目已记录")).not.toBeInTheDocument();
  },
};

function PaginationHarness() {
  const [pageIndex, setPageIndex] = useState(0);
  const start = pageIndex * 20;
  return <RecommendationQueueV2Review {...baseArgs} items={allItems.slice(start, start + 20)} pageIndex={pageIndex}
    onPrevious={() => setPageIndex(value => Math.max(0, value - 1))}
    onNext={() => setPageIndex(value => Math.min(2, value + 1))} />;
}

export const TwentyPerPage: Story = {
  name: "每页 20 条与最后一页",
  render: () => <PaginationHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("article")).toHaveLength(20);
    await userEvent.click(canvas.getByRole("button", { name: "下一页 · 20 条" }));
    await expect(canvas.getByText("第 2 / 3 页 · 每页 20 条")).toBeInTheDocument();
    await expect(canvas.getAllByRole("article")).toHaveLength(20);
    await userEvent.click(canvas.getByRole("button", { name: "下一页 · 20 条" }));
    await expect(canvas.getByText("第 3 / 3 页 · 每页 20 条")).toBeInTheDocument();
    await expect(canvas.getAllByRole("article")).toHaveLength(5);
    await expect(canvas.getByRole("button", { name: "下一页 · 20 条" })).toBeDisabled();
  },
};

export const MissingFacts: Story = {
  name: "关键事实缺失",
  args: {
    items: [{ ...itemAt(39), cities: [], relation: null, activeState: null, hc: null, currentStage: null,
      recentActivity: null, pipeline: null, reasons: [itemAt(39).reasons[0]], risk: "HC、关系和当前阶段缺失，不能安全推进。",
      confidence: "INSUFFICIENT", legalActions: ["WATCH"] }],
    pageIndex: 0,
    totalCount: 1,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("待确认").length).toBeGreaterThanOrEqual(5);
    await expect(canvas.queryByText("暂无第二条已验证理由")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "加入我的项目" })).not.toBeInTheDocument();
  },
};

export const NewRunAvailable: Story = {
  name: "出现新运行但不静默重排",
  args: { newRunAvailable: true, onRefreshRun: refreshRun },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("当前页面仍保持原排序，不会静默刷新。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "查看新一轮" }));
    await expect(refreshRun).toHaveBeenCalledOnce();
  },
};

export const StaleFacts: Story = {
  name: "数据过期降级为待核验",
  args: {
    items: [{ ...itemAt(31), tier: "VERIFY", confidence: "INSUFFICIENT", factsUpdatedAt: "2026-07-01T09:00:00+08:00",
      risk: "职位事实已超过有效窗口，请先核验招聘状态和 HC。", legalActions: ["WATCH"] }],
    pageIndex: 0,
    totalCount: 1,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("待核验，1格信号")).toBeInTheDocument();
    await expect(canvas.queryByText("事实不足")).not.toBeInTheDocument();
    await expect(canvas.queryByText("职位事实已超过有效窗口，请先核验招聘状态和 HC。")).not.toBeInTheDocument();
  },
};

export const PageLoadFailure: Story = {
  name: "分页加载失败",
  args: { items: allItems.slice(20, 40), pageIndex: 1, error: "网络中断，仍停留在当前页。", onNext: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("网络中断，仍停留在当前页。");
    await expect(canvas.getAllByRole("article")).toHaveLength(20);
    await expect(canvas.getByRole("button", { name: "重试" })).toBeInTheDocument();
  },
};

export const ActionFailure: Story = {
  name: "动作失败保留上下文",
  args: {
    items: [{ ...itemAt(0), legalActions: ["DISMISS"] }],
    totalCount: 1,
    onAction: async () => { throw new Error("职位状态已变化，请刷新后重试"); },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "暂不考虑" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("职位状态已变化，请刷新后重试");
    await expect(canvas.getByRole("article")).toBeInTheDocument();
  },
};

export const NarrowScreen: Story = {
  name: "窄屏审核",
  args: { items: allItems.slice(0, 3), totalCount: 3 },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
