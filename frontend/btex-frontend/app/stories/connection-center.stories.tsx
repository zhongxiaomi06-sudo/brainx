import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ConnectionCenter } from "../connection-center";
import type { ProviderConnection } from "../brainx-connections-api";

const checked = "2026-09-24T09:20:00.000Z";
const base = {
  kind: "sourcing",
  managed_by: "user",
  capabilities: ["candidate.search"],
  needs_user_action: false,
  action: null,
  last_checked_at: checked,
  error_code: null,
} satisfies Omit<ProviderConnection, "provider" | "state">;

const items: ProviderConnection[] = [
  { ...base, provider: "feishu", kind: "identity", state: "connected", capabilities: ["identity.login"] },
  { ...base, provider: "openmai", state: "connected" },
  {
    ...base,
    provider: "supermai",
    managed_by: "device",
    state: "action_required",
    needs_user_action: true,
    error_code: "SUPERMAI_PLATFORM_LOGIN_REQUIRED",
    details: {
      desktop_available: true,
      version: "0.3.9",
      platforms: { boss: { running: true, logged_in: false }, maimai: {}, liepin: {} },
    },
  },
  {
    ...base,
    provider: "reloop",
    managed_by: "organization",
    state: "organization_managed",
    capabilities: ["candidate.shortlist"],
    details: { backend: "mysql", schema: "ready" },
  },
];

const refresh = fn();
const start = fn();
const reauthorize = fn();

const meta = {
  title: "工作台/连接中心",
  component: ConnectionCenter,
  args: {
    items,
    onRefresh: refresh,
    onStartSupermai: start,
    onReauthorizeFeishu: reauthorize,
  },
} satisfies Meta<typeof ConnectionCenter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RealConnectionStates: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "连接中心" })).toBeInTheDocument();
    await expect(canvas.getByText("3/4")).toBeInTheDocument();
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /BOSS/ }));
    await expect(start).toHaveBeenCalledWith("boss");
  },
};

export const DesktopUnavailable: Story = {
  args: {
    items: items.map(item => item.provider === "supermai" ? {
      ...item,
      state: "unavailable",
      details: { desktop_available: false, platforms: {} },
      error_code: "SUPERMAI_DESKTOP_UNAVAILABLE",
    } : item),
  },
};

export const Loading: Story = { args: { items: [], loading: true } };

export const Narrow: Story = { parameters: { viewport: { defaultViewport: "mobile1" } } };
