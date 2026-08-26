import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { TtcJobsTable, type TtcFieldCapability, type TtcJobTableRow } from "../ttc-jobs-table";

const rows: TtcJobTableRow[] = [
  {
    projectId: "TTC-EXAMPLE-001",
    role: "独立端首页推荐策略负责人",
    company: "示例客户 A",
    cities: ["北京市", "上海市"],
    activeState: "OPEN",
    hc: 2,
    pipeline: { sourcing: 3, recommendation: 5, interview: 1 },
    ownerName: "顾问甲",
    capturedAt: "2026-08-26T09:30:00+08:00",
  },
  {
    projectId: "TTC-EXAMPLE-002",
    role: "解决方案交付 PMO 负责人",
    company: "示例客户 B",
    cities: ["北京市"],
    activeState: "COOLING",
    hc: 6,
    pipeline: { sourcing: 8, recommendation: 12, interview: 4, offer: 1 },
    ownerName: "顾问乙",
    capturedAt: "2026-08-25T18:20:00+08:00",
  },
  {
    projectId: "TTC-EXAMPLE-003",
    role: "部署测试工程师",
    company: "示例客户 A",
    cities: ["上海市"],
    activeState: "OPEN",
    hc: 3,
    pipeline: { sourcing: 2, recommendation: 4 },
    ownerName: "顾问甲",
    capturedAt: "2026-08-24T11:00:00+08:00",
  },
  {
    projectId: "TTC-EXAMPLE-004",
    role: "资本市场助理",
    company: "示例客户 C",
    cities: [],
    activeState: "UNKNOWN",
    hc: null,
    pipeline: null,
    ownerName: null,
    capturedAt: null,
  },
];

const capabilities: TtcFieldCapability[] = [
  { key: "company", displayAvailable: true, filterAvailable: true, coverage: 1 },
  { key: "city", displayAvailable: true, filterAvailable: true, coverage: 0.95 },
  { key: "active_state", displayAvailable: true, filterAvailable: true, coverage: 1 },
  { key: "hc", displayAvailable: true, filterAvailable: true, coverage: 0.94 },
  { key: "owner_name", displayAvailable: true, filterAvailable: true, coverage: 0.92 },
];

const meta = {
  title: "业务组件/TTC 真实职位表",
  component: TtcJobsTable,
  args: { rows, capabilities, onOpen: fn() },
  parameters: { layout: "fullscreen", surfaceClass: "ttc-jobs-story" },
} satisfies Meta<typeof TtcJobsTable>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  name: "默认主表",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByRole("columnheader", { name: "职位" })).toBeInTheDocument();
    expect(canvas.getByText("Sourcing 3 · 推荐 5 · 面试 1")).toBeInTheDocument();
    expect(canvas.queryByText("综合分")).not.toBeInTheDocument();
    expect(canvas.queryByText("职位类型")).not.toBeInTheDocument();
    expect(canvas.queryByText("招聘意愿")).not.toBeInTheDocument();
    expect(canvas.queryByText("信号轨道")).not.toBeInTheDocument();
  },
};

export const HeaderFiltering: Story = {
  name: "表头筛选与排序",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "筛选公司" }));
    await userEvent.click(canvas.getByRole("option", { name: "示例客户 B" }));
    expect(canvas.getByText("解决方案交付 PMO 负责人")).toBeInTheDocument();
    expect(canvas.queryByText("部署测试工程师")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: /公司：示例客户 B/ }));
    await userEvent.click(canvas.getByRole("button", { name: "筛选城市" }));
    await userEvent.click(canvas.getByRole("option", { name: "上海市" }));
    expect(canvas.getByText("独立端首页推荐策略负责人")).toBeInTheDocument();
    expect(canvas.getByText("部署测试工程师")).toBeInTheDocument();
    expect(canvas.queryByText("解决方案交付 PMO 负责人")).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: /城市：上海市/ }));
    const search = canvas.getByRole("textbox", { name: "搜索职位或公司" });
    await userEvent.type(search, "部署");
    expect(canvas.getByText("部署测试工程师")).toBeInTheDocument();
    expect(canvas.queryByText("独立端首页推荐策略负责人")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "清除全部" }));

    await userEvent.click(canvas.getByRole("button", { name: "按 HC 排序" }));
    const firstDataRow = canvas.getAllByRole("row")[1];
    expect(within(firstDataRow).getByText("解决方案交付 PMO 负责人")).toBeInTheDocument();
    await userEvent.click(within(firstDataRow).getByRole("button", { name: "详情" }));
    expect(args.onOpen).toHaveBeenCalledWith("TTC-EXAMPLE-002");
  },
};

export const MissingFields: Story = {
  name: "缺失字段诚实展示",
  args: { rows: [rows[3]] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getAllByText("待确认").length).toBeGreaterThanOrEqual(5);
    expect(canvas.queryByText("HC 0")).not.toBeInTheDocument();
  },
};

export const CapabilityDegraded: Story = {
  name: "字段能力降级",
  args: {
    capabilities: capabilities.map((capability) => capability.key === "owner_name"
      ? { ...capability, filterAvailable: false, coverage: 0.42 }
      : capability),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const ownerFilter = canvas.getByRole("button", { name: "筛选主做顾问" });
    expect(ownerFilter).toBeDisabled();
    expect(ownerFilter).toHaveAttribute("title", "当前仅 42% 的职位有该字段，暂不开放筛选");
    expect(canvas.getAllByText("顾问甲").length).toBeGreaterThan(0);
  },
};

export const NoMatchingResult: Story = {
  name: "无匹配结果",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "搜索职位或公司" }), "不存在的职位");
    expect(canvas.getByText("没有符合条件的职位")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "清除条件" }));
    expect(canvas.getByText("独立端首页推荐策略负责人")).toBeInTheDocument();
  },
};

export const EmptySource: Story = {
  name: "TTC 真实空数据",
  args: { rows: [] },
};
