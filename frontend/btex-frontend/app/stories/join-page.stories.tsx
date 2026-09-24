import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import JoinPage from "../join/page";

const meta = {
  title: "入口/首次进入",
  component: JoinPage,
  parameters: { bare: true },
} satisfies Meta<typeof JoinPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: /一次登录/ })).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: /使用飞书进入/ })).toHaveAttribute("href", "/api/v1/oauth/authorize");
    await expect(canvas.getByText("第一次进入，只走三步")).toBeInTheDocument();
  },
};

export const Mobile: Story = { parameters: { viewport: { defaultViewport: "mobile1" } } };
