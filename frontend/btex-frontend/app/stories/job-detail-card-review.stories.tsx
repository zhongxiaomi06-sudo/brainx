import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  JobDetailCard,
  type JobDetailReviewData,
} from "../job-detail-card-review";

const completeJob: JobDetailReviewData = {
  projectId: "TTC-EXAMPLE-021",
  role: "硬件开发工程师 / 架构师",
  company: "示例智能科技",
  cities: ["深圳市", "上海市"],
  activeState: "OPEN",
  hc: 2,
  pipeline: { sourcing: 8, recommendation: 3, interview: 2, offer: 1 },
  ownerName: "顾问甲",
  capturedAt: "2026-08-27T10:20:00+08:00",
  relation: "团队共享",
  companyType: "智能硬件",
  priority: "高",
  currentStage: "面试推进",
  nextAction: "本周确认客户面试反馈",
  notes: "客户重点关注硬件架构与量产经验。",
  recommendation: {
    action: "FOLLOW",
    reasons: ["职位仍在招聘，HC 与主做顾问信息完整。", "Pipeline 已进入面试阶段，当前存在明确推进动作。"],
    risks: ["需确认上海办公比例"],
    generatedAt: "2026-08-27T10:25:00+08:00",
    policyVersion: "baseline-1.0",
  },
  events: [
    { id: "event-1", label: "已查看职位", at: "2026-08-27T10:30:00+08:00" },
    { id: "event-2", label: "TTC 快照已更新", at: "2026-08-27T10:20:00+08:00" },
  ],
};

const missingJob: JobDetailReviewData = {
  projectId: "TTC-EXAMPLE-022",
  role: "数据平台负责人",
  company: "示例企业服务公司",
  cities: [],
  activeState: "UNKNOWN",
  hc: null,
  pipeline: null,
  ownerName: null,
  capturedAt: null,
  relation: null,
  currentStage: null,
  recommendation: null,
};

const trailJob: JobDetailReviewData = {
  ...completeJob,
  events: [
    { id: "event-old", label: "较早记录", at: "2026-08-27T10:20:00+08:00" },
    { id: "event-new", label: "最新记录", at: "2026-08-30T17:11:00+08:00" },
    { id: "event-middle", label: "中间记录", at: "2026-08-29T09:30:00+08:00" },
    { id: "event-oldest", label: "最早记录", at: "2026-08-26T23:58:00+08:00" },
  ],
};

const close = fn();
const addToProjects = fn();
const dismiss = fn();
const openSource = fn();

const meta = {
  title: "业务组件/居中职位事实卡审核稿",
  component: JobDetailCard,
  args: {
    job: completeJob,
    onClose: close,
    onAddToProjects: addToProjects,
    onDismiss: dismiss,
    onOpenSource: openSource,
  },
  parameters: { bare: true, layout: "fullscreen" },
} satisfies Meta<typeof JobDetailCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function EntryHarness({ mode, initialJob = completeJob }: { mode: "today" | "all"; initialJob?: JobDetailReviewData }) {
  const [jobs, setJobs] = useState([initialJob]);
  const [selected, setSelected] = useState<JobDetailReviewData | null>(null);
  const [notice, setNotice] = useState("");

  const add = (projectId: string) => {
    setJobs((current) => current.map((job) => job.projectId === projectId ? { ...job, inMyProjects: true } : job));
    setSelected((current) => current?.projectId === projectId ? { ...current, inMyProjects: true } : current);
    setNotice("已加入我的项目");
  };
  const dismiss = (projectId: string) => {
    setJobs((current) => current.filter((job) => job.projectId !== projectId));
    setSelected(null);
    setNotice("该职位已隐藏");
  };

  return (
    <div style={{ minHeight: "100vh", padding: 48, background: "#f2f5f3", fontFamily: "Inter, PingFang SC, sans-serif" }}>
      <div style={{ maxWidth: 940, margin: "0 auto" }}>
        <small style={{ color: "#17856f", fontWeight: 800, letterSpacing: ".12em" }}>
          {mode === "today" ? "TODAY DECISION" : "ALL POSITIONS"}
        </small>
        <h1 style={{ margin: "10px 0 24px", fontSize: 28 }}>
          {mode === "today" ? "精选盘" : "全部职位"}
        </h1>
        {jobs.map((job) => mode === "today" ? (
          <button
            key={job.projectId}
            type="button"
            aria-label={`打开精选盘职位：${job.role}`}
            onClick={() => setSelected(job)}
            style={{ width: 360, padding: 22, border: "1px solid #d9e5e0", borderRadius: 18, background: "#fff", textAlign: "left", cursor: "pointer", boxShadow: "0 8px 26px rgba(27,55,46,.08)" }}
          >
            <b style={{ display: "block", marginBottom: 8, fontSize: 17 }}>{job.role}</b>
            <span style={{ color: "#6c7b76", fontSize: 12 }}>
              {job.company} · {job.cities.join("、") || "城市待确认"}
            </span>
          </button>
        ) : (
          <button
            key={job.projectId}
            type="button"
            aria-label={`打开全部职位：${job.role}`}
            onClick={() => setSelected(job)}
            style={{ width: "100%", display: "grid", gridTemplateColumns: "2fr 1.2fr 1fr 1fr", gap: 18, padding: "18px 20px", border: "1px solid #dfe6e3", borderRadius: 12, background: "#fff", color: "#293a35", textAlign: "left", cursor: "pointer" }}
          >
            <b>{job.role}</b><span>{job.company}</span>
            <span>{job.cities.join("、") || "待确认"}</span><span>HC {job.hc ?? "待确认"}</span>
          </button>
        ))}
        {jobs.length === 0 && (
          <div role="status" style={{ padding: 38, border: "1px dashed #cfdad6", borderRadius: 14, color: "#6d7c77", textAlign: "center" }}>
            当前列表没有待处理职位
          </div>
        )}
        {notice && <p role="status" style={{ color: "#17856f" }}>{notice}</p>}
      </div>
      {selected && (
        <JobDetailCard
          job={selected}
          onClose={() => setSelected(null)}
          onAddToProjects={add}
          onDismiss={dismiss}
          onOpenSource={openSource}
        />
      )}
    </div>
  );
}

export const TodayDecisionEntry: Story = {
  name: "从精选盘打开",
  render: () => <EntryHarness mode="today" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /打开精选盘职位/ }));
    await expect(canvas.getByRole("dialog", { name: completeJob.role })).toBeInTheDocument();
    await expect(canvas.getByText("核心职位事实")).toBeInTheDocument();
    await expect(canvas.getByText("寻访")).toBeInTheDocument();
    await expect(canvas.getByText("备注与职位描述")).toBeInTheDocument();
    await expect(canvas.getByText(completeJob.notes || "")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "职位事实" })).toHaveAttribute("aria-current", "page");
    await expect(canvas.queryByText(/AI 匹配分|最终得分|探索价值|证据覆盖/)).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "判断" }));
    await expect(canvas.getByText("当前判断")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "职位事实" }));
    await userEvent.click(canvas.getByRole("button", { name: "加入我的项目" }));
    await expect(canvas.getByRole("button", { name: "已加入我的项目" })).toBeDisabled();
  },
};

export const AllPositionsEntry: Story = {
  name: "从全部职位打开并隐藏",
  render: () => <EntryHarness mode="all" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /打开全部职位/ }));
    await expect(canvas.getByRole("dialog", { name: completeJob.role })).toBeInTheDocument();
    await expect(canvas.getByText("TTC CRM 职位快照")).toBeInTheDocument();
    await expect(canvas.getByText("备注与职位描述")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "暂不考虑" }));
    await expect(canvas.queryByRole("dialog")).not.toBeInTheDocument();
    await expect(canvas.getByText("当前列表没有待处理职位")).toBeInTheDocument();
  },
};

export const HonestMissingFields: Story = {
  name: "字段缺失不补假值",
  render: () => <EntryHarness mode="all" initialJob={missingJob} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /打开全部职位/ }));
    await expect(canvas.getAllByText("待确认").length).toBeGreaterThanOrEqual(4);
    await expect(canvas.getByText("暂无可核验进展")).toBeInTheDocument();
    await expect(canvas.queryByText(/HC 0/)).not.toBeInTheDocument();
    await expect(canvas.queryByText("今日建议")).not.toBeInTheDocument();
  },
};

export const NarrowReview: Story = {
  name: "窄屏居中卡",
  render: () => <EntryHarness mode="today" />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const DecisionTrailNewestFirst: Story = {
  name: "决策轨迹最新在前",
  render: () => <JobDetailCard job={trailJob} onClose={close} activeTab="trail" />,
  play: async ({ canvasElement }) => {
    const labels = [...canvasElement.querySelectorAll(".job-detail-review-events b")]
      .map((element) => element.textContent);
    await expect(labels).toEqual(["最新记录", "中间记录", "较早记录"]);
    await expect(labels).not.toContain("最早记录");
  },
};
