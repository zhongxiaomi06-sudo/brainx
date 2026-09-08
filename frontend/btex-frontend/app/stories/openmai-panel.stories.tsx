import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { OpenmaiPanel } from "../openmai-panel";

const rerun = fn();
const meta = {
  title: "业务组件/OpenMai 岗位画像输入",
  component: OpenmaiPanel,
  parameters: { bare: true },
  args: {
    jobId: "P-NEEDS-INPUT",
    mode: "connected",
    openmai: { status: "needs_input", result_text: "请选择测试岗位画像" },
    onRerun: rerun,
  },
} satisfies Meta<typeof OpenmaiPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsInput: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "补充岗位画像" });
    await userEvent.type(input, "功率模块研发负责人，必须有 SiC 经验");
    await userEvent.click(canvas.getByRole("button", { name: "用此画像开始找人" }));
    await expect(rerun).toHaveBeenCalledWith("P-NEEDS-INPUT", "功率模块研发负责人，必须有 SiC 经验");
  },
};
