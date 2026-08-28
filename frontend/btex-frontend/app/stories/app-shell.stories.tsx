import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import ErrorBoundary, { ErrorFallback } from "../error-boundary";
import { SettingsCenterReview, type SettingsCenterData } from "../settings-center-review";
import DecisionWorkbench from "../workbench";
import { WorkspaceShell, type WorkspaceShellPage } from "../workspace-shell";

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

const pageCopy: Record<Exclude<WorkspaceShellPage, "today" | "settings">, string> = {
  jobs: "集中检索、筛选和核验 TTC 职位事实。",
  projects: "跟进已经关注、承接和等待记录结果的项目。",
  clients: "按客户聚合真实职位、HC 和最近变化。",
};

function TodayBlocks() {
  return (
    <div className="shell-review-page">
      <section className="shell-review-section">
        <header><div><p className="shell-review-kicker">DECISION QUEUE</p><h2>待判断职位</h2></div><span>按真实推进信号排序</span></header>
        <div className="shell-review-toolbar">搜索职位、公司或关键词</div>
        <div className="shell-review-list">
          <div className="shell-review-row"><span className="shell-review-rank">01</span><span className="shell-review-row-copy"><b>训练 / 推理框架 Infra 工程师</b><small>北京乾章科技 · 北京市 · 招聘中</small></span><span className="shell-review-action">查看并处理 →</span></div>
          <div className="shell-review-row"><span className="shell-review-rank">02</span><span className="shell-review-row-copy"><b>机械结构工程师</b><small>slash robotics · 苏州市 · 待核验</small></span><span className="shell-review-action">核验关键事实 →</span></div>
        </div>
      </section>
    </div>
  );
}

const shellSettingsData: SettingsCenterData = {
  profile: { consultantId: "mia", displayName: "Mia 钟笑咪", keywords: ["AI 应用", "企业服务"], note: "关注产品与商业化交叉方向。", feishuAuthorized: true, feishuNeedsReauth: false },
  ttc: { connected: true, userName: "已验证顾问", expiresAt: "2026-09-02", needsReauth: false },
  talent: { backend: "mysql", connected: true, schema: "ready", database: "reloop", host: null, degraded: null },
  strategy: { policyVersion: "policy-1.1", customized: false },
  sync: { state: "READY", rowsRead: 128, rowsExpected: 128, updatedAt: "2026-08-27", errors: [], fieldReport: { schemaVersion: "ttc-job-fields-v1", totalRows: 128, filterableFields: ["公司", "城市", "TTC 状态"], unavailableFilters: ["行业", "招聘意愿"] } },
};

function ShellReviewHarness() {
  const [page, setPage] = useState<WorkspaceShellPage>("today");
  const [assistantOpen, setAssistantOpen] = useState(false);
  if (page === "settings") return <SettingsCenterReview data={shellSettingsData} onBack={() => setPage("today")} />;
  return (
    <WorkspaceShell
      activePage={page}
      onNavigate={setPage}
      assistantOpen={assistantOpen}
      onAssistantToggle={() => setAssistantOpen(value => !value)}
      assistant={<div className="shell-assistant-preview"><p>助手按需出现，只读取当前页面上下文。</p><div>当前页面：{page === "today" ? "今日决策" : page}</div></div>}
    >
      {page === "today" ? <TodayBlocks /> : (
        <div className="shell-settings-page"><header><p className="shell-review-kicker">WORKSPACE</p><h1>{page === "jobs" ? "全部职位" : page === "projects" ? "我的项目" : "客户洞察"}</h1><p>{pageCopy[page]}</p></header><section className="shell-review-section">此阶段只审核页面归属和大板块，不改造内部业务组件。</section></div>
      )}
    </WorkspaceShell>
  );
}

export const MainBlocksReview: Story = {
  render: () => <ShellReviewHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("TODAY'S DECISIONS")).not.toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "待判断职位" })).toBeInTheDocument();
    await expect(canvas.queryByText(/已同步/)).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /提醒/ })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "用户与设置" }));
    await expect(canvas.getByText("工作台设置")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("menuitem", { name: "工作台设置" }));
    await expect(canvas.getByRole("heading", { name: "个人资料" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "数据连接" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "返回应用" }));
    await userEvent.click(canvas.getByRole("button", { name: "全部职位" }));
    await expect(canvas.getByRole("heading", { name: "全部职位" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "今日决策" }));
    await expect(canvas.getByRole("heading", { name: "待判断职位" })).toBeInTheDocument();
  },
};

export const MainBlocksNarrowReview: Story = {
  render: () => <ShellReviewHarness />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
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
