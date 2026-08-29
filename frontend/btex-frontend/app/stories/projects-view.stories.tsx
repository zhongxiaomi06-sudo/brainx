import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { ProjectStatus, ProjectSummary } from "../brainx-projects-api";
import { ProjectsView } from "../projects-view";

const open = fn();

function project(projectId: string, status: ProjectStatus, overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  const following = status === "IN_PROGRESS" || status === "NEEDS_ACTION";
  return {
    project_id: projectId,
    relation: "MY_JOB",
    membership_source: "storybook",
    joined_at: "2026-08-28T09:00:00.000Z",
    company: "脱敏客户",
    role: "职位待确认",
    city: "上海市",
    active_state: "OPEN",
    hc: 1,
    pipeline: "推荐 4 · 面试 2",
    current_stage: "寻访",
    pipeline_snapshot: "推荐 4 · 面试 2",
    next_action: "确认本周客户反馈",
    owner_name: "Mia",
    captured_at: "2026-08-29T08:00:00.000Z",
    engagement_state: status === "COMPLETED" ? "COMPLETED" : status === "RELEASED" ? "RELEASED" : following ? "ACCEPTED" : "NEW",
    state_since: "2026-08-29T08:00:00.000Z",
    project_status: status,
    active_action: following ? {
      action_id: `action-${projectId}`,
      title: "向客户确认候选人反馈",
      goal: "本周推进两位候选人进入面试",
      due_at: "2099-08-30T10:00:00.000Z",
      status: status === "NEEDS_ACTION" ? "BLOCKED" : "OPEN",
      source: "MANUAL",
      updated_at: "2026-08-29T08:00:00.000Z",
    } : null,
    legal_actions: status === "PENDING_START" ? ["ACCEPT", "WATCH"] : following ? ["RELEASE"] : [],
    ...overrides,
  };
}

const projects = [
  project("P-NEEDS", "NEEDS_ACTION", { company: "云帆科技", role: "客户成功负责人" }),
  project("P-PENDING", "PENDING_START", { company: "深势科技", role: "AI 产品负责人" }),
  project("P-ACTIVE", "IN_PROGRESS", { company: "光轮智能", role: "算法工程师" }),
  project("P-DONE", "COMPLETED", { company: "星河数据", role: "增长负责人" }),
  project("P-RELEASED", "RELEASED", { company: "远帆出海", role: "海外市场负责人" }),
];

const meta = {
  title: "业务组件/我的项目行动工作台",
  component: ProjectsView,
  parameters: { bare: true },
  args: { projects, query: "", setQuery: fn(), focusedProjectId: null, open },
} satisfies Meta<typeof ProjectsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllStates: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "我的项目" })).toBeInTheDocument();
    await expect(canvas.getAllByRole("article")).toHaveLength(5);
    await userEvent.click(canvas.getByRole("button", { name: /需处理/ }));
    await expect(canvas.getByRole("article", { name: "客户成功负责人 · 云帆科技" })).toBeInTheDocument();
    await expect(canvas.queryByRole("article", { name: "AI 产品负责人 · 深势科技" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "立即处理" }));
    await expect(open).toHaveBeenCalledWith(expect.objectContaining({ project_id: "P-NEEDS" }));
  },
};

export const FocusedNewProject: Story = {
  args: { focusedProjectId: "P-PENDING" },
};

export const Empty: Story = {
  args: { projects: [] },
};

export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => {
    const documentElement = canvasElement.ownerDocument.documentElement;
    await expect(documentElement.scrollWidth).toBeLessThanOrEqual(documentElement.clientWidth);
  },
};
