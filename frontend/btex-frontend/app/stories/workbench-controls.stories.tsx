import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import {
  DirectGlassSegment,
  DrawerSection,
  FilterSelect,
  Heading,
  StatusTag,
} from "../workbench-controls";

const meta = {
  title: "基础控件/工作台控件",
  parameters: { surfaceClass: "storybook-compact" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const filterOptions = [
  { value: "all", label: "全部职位" },
  { value: "mine", label: "我的职位" },
  { value: "team", label: "团队职位" },
];

function FilterSelectHarness() {
  const [value, setValue] = useState("all");
  return (
    <div className="storybook-panel">
      <FilterSelect
        value={value}
        options={filterOptions}
        onChange={setValue}
        ariaLabel="职位范围"
      />
      <p>当前值：{value}</p>
    </div>
  );
}

export const FilterMenu: Story = {
  render: () => <FilterSelectHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "职位范围" }));
    await userEvent.click(canvas.getByRole("option", { name: "我的职位" }));
    await expect(canvas.getByText("当前值：mine")).toBeInTheDocument();
  },
};

const segmentOptions = [
  { value: "recommended", label: "推荐", ariaLabel: "按推荐排序" },
  { value: "activity", label: "活跃", ariaLabel: "按活跃度排序" },
  { value: "newest", label: "最新", ariaLabel: "按发布时间排序" },
] as const;

function SegmentHarness() {
  const [value, setValue] = useState<(typeof segmentOptions)[number]["value"]>("recommended");
  return (
    <div className="storybook-panel storybook-stack">
      <DirectGlassSegment
        value={value}
        options={segmentOptions}
        onChange={setValue}
        ariaLabel="排序方式"
      />
      <p>当前排序：{value}</p>
    </div>
  );
}

export const SortSegment: Story = {
  render: () => <SegmentHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "按活跃度排序" }));
    await expect(canvas.getByText("当前排序：activity")).toBeInTheDocument();
  },
};

export const Statuses: Story = {
  render: () => (
    <div className="storybook-panel storybook-row">
      {[
        "新发布",
        "活跃",
        "拥挤",
        "降温",
        "已关闭",
        "同步异常",
      ].map((status) => <StatusTag key={status} s={status} />)}
    </div>
  ),
};

export const HeadingAndSection: Story = {
  render: () => (
    <div className="storybook-stack">
      <Heading
        code="TODAY / 今日建议"
        title="今天先做什么"
        desc="只展示有事实证据的优先事项。"
        action={<button className="btn primary">刷新推荐</button>}
      />
      <div className="storybook-panel">
        <DrawerSection title="判断依据" action={<StatusTag s="活跃" />}>
          <p>客户意向、职位状态和个人方向共同构成判断依据。</p>
        </DrawerSection>
      </div>
    </div>
  ),
};
