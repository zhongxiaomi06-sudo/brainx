import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ClientInsightsReview, type ClientFactRow } from "../client-insights-review";
import { WorkspaceShell } from "../workspace-shell";

const clients: ClientFactRow[] = [
  { company: "脱敏客户 A", companyType: "企业服务", jobCount: 8, activeJobs: 5, knownHc: 11, lastActivity: "2026-08-27T03:20:00Z", relations: ["MY_JOB", "TEAM_SHARED"], states: ["OPEN", "COOLING"] },
  { company: "脱敏客户 B", companyType: null, jobCount: 4, activeJobs: 2, knownHc: null, lastActivity: "2026-08-26T09:10:00Z", relations: ["TEAM_SHARED"], states: ["OPEN"] },
  { company: "脱敏客户 C", companyType: "智能硬件", jobCount: 3, activeJobs: 0, knownHc: 0, lastActivity: null, relations: ["OTHER_CONSULTANT"], states: ["CLOSED"] },
];

const openJobs = fn();
const meta = { title: "业务组件/客户洞察", component: ClientInsightsReview, parameters: { bare: true }, args: { clients, onOpenJobs: openJobs } } satisfies Meta<typeof ClientInsightsReview>;
export default meta;
type Story = StoryObj<typeof meta>;

function StoryHarness({ rows = clients }: { rows?: ClientFactRow[] }) {
  return <WorkspaceShell activePage="clients" onNavigate={fn()}><ClientInsightsReview clients={rows} onOpenJobs={openJobs} /></WorkspaceShell>;
}

export const VerifiedFacts: Story = {
  render: () => <StoryHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "客户洞察" })).toBeInTheDocument();
    await expect(canvas.queryByRole("columnheader", { name: /招聘意愿|转化率|优先级评分/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "查看 脱敏客户 A 事实" }));
    await expect(canvas.getByLabelText("脱敏客户 A 客户事实")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "查看该客户的全部职位" }));
    await expect(openJobs).toHaveBeenCalledWith("脱敏客户 A");
    await userEvent.click(canvas.getAllByRole("button", { name: "关闭客户事实" })[1]);
    await userEvent.type(canvas.getByRole("textbox", { name: "搜索客户" }), "客户 B");
    await expect(canvas.getByText("脱敏客户 B")).toBeInTheDocument();
    await expect(canvas.queryByText("脱敏客户 A")).not.toBeInTheDocument();
    await userEvent.clear(canvas.getByRole("textbox", { name: "搜索客户" }));
  },
};

export const MissingFacts: Story = { render: () => <StoryHarness rows={[clients[1]]} /> };
export const Empty: Story = { render: () => <StoryHarness rows={[]} /> };
export const NarrowReview: Story = { render: () => <StoryHarness />, parameters: { viewport: { defaultViewport: "mobile1" } } };
