import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within, waitFor } from "storybook/test";
import { OpenmaiPanel } from "../openmai-panel";

const rerun = fn();
const meta = {
  title: "业务组件/OpenMai 职位信息输入",
  component: OpenmaiPanel,
  parameters: { bare: true },
  args: {
    jobId: "P-NEEDS-INPUT",
    mode: "connected",
    openmai: { status: "needs_input", result_text: "请选择测试职位信息" },
    onRerun: rerun,
    briefApi: {
      load: async () => ({ search_brief: "", version: 0, updated_by: null, updated_at: null }),
      save: async (_id, search_brief, version) => ({ search_brief, version: version + 1, updated_by: "review", updated_at: null }),
    },
  },
} satisfies Meta<typeof OpenmaiPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsInput: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const input = canvas.getByRole("textbox", { name: "补充职位信息" });
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.type(input, "北京、半导体、总监");
    await expect(canvas.getByRole("button", { name: "用此画像开始找人" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "保存条件" }));
    await canvas.findByText(/条件已保存，下次找人生效/);
    await expect(rerun).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "用此画像开始找人" }));
    await expect(rerun).toHaveBeenCalledWith("P-NEEDS-INPUT", "");
  },
};
