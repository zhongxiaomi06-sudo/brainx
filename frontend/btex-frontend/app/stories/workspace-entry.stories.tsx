import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { WorkspaceEntry } from "../workbench-entry";

const meta = {
  title: "组合场景/真实数据入口",
  component: WorkspaceEntry,
  args: { onRetry: fn(), onCheckConnection: fn(async () => {}), onOpenSources: fn() },
  decorators: [(Story) => <div style={{ padding: 24, minHeight: "100vh", background: "#f4f6f7" }}><Story /></div>],
} satisfies Meta<typeof WorkspaceEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Connecting: Story = { args: { kind: "connecting" } };

export const LoginRequired: Story = {
  args: {
    kind: "auth",
    sampleConsultants: [
      { consultant_id: "felix", display_name: "Felix" },
      { consultant_id: "mia", display_name: "Mia" },
    ],
  },
};

export const ServiceUnavailable: Story = { args: { kind: "unavailable" } };
