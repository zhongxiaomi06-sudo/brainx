import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SettingsCenterReview, type SettingsCenterData } from "../settings-center-review";
import { WorkspaceShell } from "../workspace-shell";

const healthyData: SettingsCenterData = {
  profile: {
    consultantId: "mia",
    displayName: "Mia 钟笑咪",
    keywords: ["AI 应用", "企业服务", "增长"],
    note: "关注产品与商业化交叉方向。",
    feishuAuthorized: true,
    feishuNeedsReauth: false,
  },
  ttc: { connected: true, userName: "已验证顾问", expiresAt: "2026-09-02", needsReauth: false },
  talent: { backend: "mysql", connected: true, schema: "ready", database: "reloop", host: "RDS 内网地址（已脱敏）", degraded: null },
  strategy: { policyVersion: "policy-1.1", customized: false },
  sync: {
    state: "READY",
    rowsRead: 128,
    rowsExpected: 128,
    updatedAt: "2026-08-27",
    errors: [],
    fieldReport: {
      schemaVersion: "ttc-job-fields-v1",
      totalRows: 128,
      filterableFields: ["公司", "城市", "TTC 状态", "HC", "主做顾问"],
      unavailableFilters: ["行业", "公司阶段", "招聘意愿"],
    },
  },
};

const needsAttentionData: SettingsCenterData = {
  ...healthyData,
  profile: { ...healthyData.profile, feishuAuthorized: true, feishuNeedsReauth: true },
  ttc: { connected: false, userName: null, expiresAt: null, needsReauth: true },
  talent: { backend: "memory", connected: true, schema: "not_applicable", database: null, host: null, degraded: "MySQL 未连接，当前为重启即失的内存回退" },
  strategy: { policyVersion: null, customized: false },
  sync: {
    state: "INCOMPLETE",
    rowsRead: 76,
    rowsExpected: 128,
    updatedAt: "2026-08-27",
    errors: ["TTC 凭证已失效，职位列表只读取到部分结果"],
    fieldReport: null,
  },
};

const action = fn();

const meta = {
  title: "组合场景/设置中心",
  component: SettingsCenterReview,
  parameters: { bare: true },
  args: { data: healthyData, onAction: action },
} satisfies Meta<typeof SettingsCenterReview>;

export default meta;
type Story = StoryObj<typeof meta>;

function SettingsStory({ data }: { data: SettingsCenterData }) {
  return <WorkspaceShell activePage="settings" onNavigate={fn()} consultant={data.profile.displayName}>
    <SettingsCenterReview data={data} onAction={action} />
  </WorkspaceShell>;
}

export const ConnectedHealthy: Story = {
  render: args => <SettingsStory data={args.data} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "设置中心" })).toBeInTheDocument();
    await expect(canvas.getByText("系统身份")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /数据连接/ }));
    await expect(canvas.getByRole("heading", { name: "TTC 职位系统" })).toBeInTheDocument();
    await expect(canvas.getByText("MySQL 已连接")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /推荐策略/ }));
    await expect(canvas.getByText("本轮不提前制作六维设置。")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /同步诊断/ }));
    await expect(canvas.getByText("同步完整")).toBeInTheDocument();
    await expect(canvas.getByText("招聘意愿")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /个人资料/ }));
    await expect(canvas.getByRole("heading", { name: "登录身份" })).toBeInTheDocument();
  },
};

export const NeedsAttention: Story = {
  args: { data: needsAttentionData },
  render: args => <SettingsStory data={args.data} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /数据连接/ }));
    await expect(canvas.getByRole("button", { name: "连接或更新凭证" })).toBeInTheDocument();
    await expect(canvas.getByText("降级运行")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /同步诊断/ }));
    await expect(canvas.getByText("同步不完整")).toBeInTheDocument();
    await expect(canvas.getByText("尚无字段报告")).toBeInTheDocument();
  },
};

export const NarrowReview: Story = {
  render: args => <SettingsStory data={args.data} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
