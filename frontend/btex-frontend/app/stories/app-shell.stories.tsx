import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import ErrorBoundary, { ErrorFallback } from "../error-boundary";
import DecisionWorkbench from "../workbench";

const meta = {
  title: "组合场景/应用外壳",
  parameters: { bare: true },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullWorkbench: Story = {
  render: () => <DecisionWorkbench demo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.findByRole("main", {}, { timeout: 10_000 })).resolves.toBeInTheDocument();
    await expect(canvas.getByLabelText("主要导航")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "全部职位" })).toBeInTheDocument();
  },
};

export const HealthyBoundary: Story = {
  render: () => (
    <ErrorBoundary>
      <div className="storybook-panel">错误边界内的正常内容</div>
    </ErrorBoundary>
  ),
};

const retry = fn();
const reload = fn();

export const ErrorState: Story = {
  render: () => (
    <ErrorFallback
      error={new Error("示例：组件渲染失败")}
      onRetry={retry}
      onReload={reload}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "重试" }));
    await expect(retry).toHaveBeenCalledOnce();
  },
};
