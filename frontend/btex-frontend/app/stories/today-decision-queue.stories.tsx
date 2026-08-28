import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { seedSync } from "../decision-demo";
import { TodayDecisionQueue } from "../workbench-today";

const meta = {
  title: "业务组件/今日决策队列",
  component: TodayDecisionQueue,
  args: {
    activeJobId: null,
    completed: [],
    jobs: [],
    engagement: {},
    sync: seedSync,
    open: fn(),
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
