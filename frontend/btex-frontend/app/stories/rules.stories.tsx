import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { Rules } from "../workbench-rules";

const meta = {
  title: "业务组件/判断规则",
  component: Rules,
  parameters: { surfaceClass: "storybook-compact" },
  args: {
    notify: fn(),
    mode: "offline",
    policy: "baseline-1.1",
    keywords: ["海外增长", "AI 应用", "商业化"],
    note: "优先判断有真实 Pipeline 和明确负责人信息的机会。",
    onRefresh: async () => undefined,
    onProfileSaved: fn(),
  },
} satisfies Meta<typeof Rules>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OfflineBaseline: Story = {};

export const Connecting: Story = {
  args: { mode: "connecting", policy: null },
};
