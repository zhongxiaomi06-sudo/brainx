import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { JobsWorkspaceReview, type JobsWorkspaceReviewRow } from "../jobs-workspace-review";

const rows: JobsWorkspaceReviewRow[] = [
  { projectId: "TTC-EXAMPLE-001", role: "高级算法工程师", company: "示例科技 A", cities: ["北京市"], activeState: "OPEN", hc: 3, pipeline: { sourcing: 8, recommendation: 4, interview: 1 }, ownerName: "顾问甲", capturedAt: "2026-08-27T09:30:00+08:00", workflowState: "PENDING", newThisWeek: true, sourceUrl: "https://example.com/jobs/1" },
  { projectId: "TTC-EXAMPLE-002", role: "企业服务产品总监", company: "示例科技 B", cities: ["杭州市"], activeState: "OPEN", hc: 2, pipeline: { sourcing: 6, recommendation: 3 }, ownerName: "顾问乙", capturedAt: "2026-08-26T18:20:00+08:00", workflowState: "PENDING", newThisWeek: true },
  { projectId: "TTC-EXAMPLE-003", role: "解决方案架构师", company: "示例科技 C", cities: ["深圳市"], activeState: "COOLING", hc: 1, pipeline: { sourcing: 4, interview: 2 }, ownerName: "顾问甲", capturedAt: "2026-08-25T11:00:00+08:00", workflowState: "FOLLOWING" },
  { projectId: "TTC-EXAMPLE-004", role: "数据分析经理", company: "示例科技 D", cities: ["上海市"], activeState: "OPEN", hc: null, pipeline: null, ownerName: null, capturedAt: null, workflowState: "WATCHING" },
  { projectId: "TTC-EXAMPLE-005", role: "前端技术专家", company: "示例科技 E", cities: ["北京市", "上海市"], activeState: "UNKNOWN", hc: 2, pipeline: { recommendation: 2 }, ownerName: "顾问丙", capturedAt: "2026-08-24T12:00:00+08:00", workflowState: "FOLLOWING", newThisWeek: true },
];

const sync = fn();
const follow = fn();
const dismiss = fn();
const openSource = fn();

const meta = {
  title: "组合场景/现代职位工作区审核稿",
  component: JobsWorkspaceReview,
  args: { rows, initialSelectedId: null, onSync: sync, onFollow: follow, onDismiss: dismiss, onOpenSource: openSource },
  parameters: { bare: true, layout: "fullscreen" },
} satisfies Meta<typeof JobsWorkspaceReview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopReview: Story = {
  name: "桌面端主审核稿",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "同步职位" }));
    await expect(sync).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("row", { name: /高级算法工程师/ }));
    await expect(canvas.getByRole("heading", { name: "高级算法工程师" })).toBeInTheDocument();
    await expect(canvas.getByRole("dialog", { name: "高级算法工程师" })).toBeInTheDocument();
    await expect(canvas.getByText("脱敏审核数据 · 字段结构对齐 TTC 职位快照")).toBeInTheDocument();
    await expect(canvas.queryByText(/AI 匹配分/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "加入我的项目" }));
    await expect(follow).toHaveBeenCalledWith("TTC-EXAMPLE-001");
    await userEvent.click(canvas.getByRole("button", { name: "查看来源" }));
    await expect(openSource).toHaveBeenCalledWith("TTC-EXAMPLE-001");
  },
};

export const FilteringAndSelection: Story = {
  name: "筛选、视图与详情联动",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("⌘K")).not.toBeInTheDocument();
    const search = canvas.getByRole("textbox", { name: "搜索职位工作区" });
    await userEvent.type(search, "企业服务");
    await expect(canvas.getByText("高级算法工程师")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "搜索" }));
    await expect(canvas.getByText("企业服务产品总监")).toBeInTheDocument();
    await expect(canvas.queryByText("高级算法工程师")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "清除条件" }));
    await userEvent.click(canvas.getByRole("tab", { name: /跟进中/ }));
    await expect(canvas.getByText("解决方案架构师")).toBeInTheDocument();
    await expect(canvas.getByText("前端技术专家")).toBeInTheDocument();
    await expect(canvas.queryByText("企业服务产品总监")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("row", { name: /解决方案架构师/ }));
    await expect(canvas.getByRole("heading", { name: "解决方案架构师" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "关闭职位详情" }));
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    await expect(canvas.getByRole("option", { name: "北京" })).toBeInTheDocument();
    await expect(canvas.queryByRole("option", { name: "北京市" })).not.toBeInTheDocument();
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "筛选城市" }), "杭州");
    await expect(canvas.getByText("没有符合条件的职位")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "清除条件" }));
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "筛选职位状态" }), "冷却");
    await expect(canvas.getByText("解决方案架构师")).toBeInTheDocument();
    await expect(canvas.queryByText("前端技术专家")).not.toBeInTheDocument();
  },
};

export const HonestMissingFields: Story = {
  name: "缺失字段不伪造",
  args: { rows: [rows[3]], initialSelectedId: "TTC-EXAMPLE-004" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("待确认").length).toBeGreaterThanOrEqual(2);
    await expect(canvas.getByText("暂无可核验进展")).toBeInTheDocument();
    await expect(canvas.queryByText("HC 0")).not.toBeInTheDocument();
  },
};

export const NarrowReview: Story = {
  name: "窄屏审核稿",
  args: { initialSelectedId: null },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const FormalEmbeddedReview: Story = {
  name: "正式页面嵌入模式",
  args: {
    embedded: true,
    dataLabel: "真实职位数据 · 来自 TTC 同步快照",
    tipText: "筛选真实职位，打开详情后可加入我的项目",
    onSync: undefined,
    onDismiss: undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("navigation", { name: "审核稿主要导航" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "同步职位" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "搜索" })).toBeInTheDocument();
    await expect(canvas.getByText("真实职位数据 · 来自 TTC 同步快照")).toBeInTheDocument();
    const row = canvas.getByRole("row", { name: /高级算法工程师/ });
    row.focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("dialog", { name: "高级算法工程师" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "暂不考虑" })).not.toBeInTheDocument();
  },
};
