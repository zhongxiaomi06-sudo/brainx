import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { DirectionProfileReview, type DirectionProfileData } from "../direction-profile-review";
import { WorkspaceShell } from "../workspace-shell";

const currentData: DirectionProfileData = {
  consultant: "Mia 钟笑咪",
  keywords: ["AI 应用", "企业服务", "增长"],
  note: "关注产品与商业化交叉方向。",
  signal: "keywords",
  historicalProjectCount: 12,
  structuredProfile: { contractReady: false, preferred: ["AI 应用", "企业服务", "增长"], excluded: [], hardConstraints: [] },
  manualOverrideContractReady: false,
  classifications: [
    { id: "sample-1", role: "AI Agent 产品经理", company: "脱敏客户 A", source: "market-csv", status: "classified", primaryDirection: "PRODUCT", secondaryDirections: [], isLeadership: false, confidence: 0.5, matchedTerms: ["产品"], excludedTerms: [], version: "rules-v1", evidence: ["keyword-rules · role=AI Agent 产品经理"] },
    { id: "sample-2", role: "海外增长负责人", company: "脱敏客户 B", source: "market-csv", status: "classified", primaryDirection: "GROWTH_LEADERSHIP", secondaryDirections: ["PAID_ACQUISITION"], isLeadership: true, confidence: 0.82, matchedTerms: ["增长负责人", "海外投放"], excludedTerms: [], version: "llm-v1", evidence: ["llm · matched=增长负责人/海外投放"] },
    { id: "sample-3", role: "训练 / 推理框架 Infra 工程师", company: "脱敏客户 C", source: "ttc", status: "missing", primaryDirection: null, secondaryDirections: [], isLeadership: null, confidence: null, matchedTerms: [], excludedTerms: [], version: null, evidence: [] },
  ],
};

const insufficientData: DirectionProfileData = {
  ...currentData,
  keywords: [],
  note: null,
  signal: "missing",
  historicalProjectCount: 0,
  structuredProfile: { contractReady: false, preferred: [], excluded: [], hardConstraints: [] },
  classifications: [currentData.classifications[2]],
};

const manualContractData: DirectionProfileData = {
  ...currentData,
  structuredProfile: { contractReady: true, preferred: ["AI 应用", "产品"], excluded: ["纯销售"], hardConstraints: ["北京 / 上海", "负责人岗位优先"] },
  manualOverrideContractReady: true,
  classifications: [
    { ...currentData.classifications[0], status: "manual", primaryDirection: "GTM_LEADERSHIP", confidence: 1, version: "manual-v1", correctedFrom: "PRODUCT", evidence: ["人工确认 · 保留原始 PRODUCT 判断"] },
  ],
};

const saveKeywords = fn();
const saveStructured = fn();
const correct = fn();

const meta = {
  title: "组合场景/方向画像",
  component: DirectionProfileReview,
  parameters: { bare: true },
  args: { data: currentData, onSaveKeywords: saveKeywords, onSaveStructuredProfile: saveStructured, onCorrectClassification: correct },
} satisfies Meta<typeof DirectionProfileReview>;

export default meta;
type Story = StoryObj<typeof meta>;

function ProfileStory({ data }: { data: DirectionProfileData }) {
  const [saved, setSaved] = useState(false);
  return <WorkspaceShell activePage="settings" onNavigate={fn()}>
    <DirectionProfileReview data={data} onSaveKeywords={() => { setSaved(true); saveKeywords(); }} onSaveStructuredProfile={saveStructured} onCorrectClassification={correct} />
    {saved && <span className="sr-only" role="status">关键词审核动作已保存</span>}
  </WorkspaceShell>;
}

export const CurrentCapability: Story = {
  render: args => <ProfileStory data={args.data} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "方向画像与职位分类" })).toBeInTheDocument();
    await expect(canvas.getByText("profile_note", { exact: false })).toBeInTheDocument();
    await expect(canvas.getByText("后端字段待补")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "编辑当前关键词" }));
    await userEvent.click(canvas.getByRole("button", { name: "保存审核动作" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("关键词审核动作已保存");
    await expect(canvas.getAllByRole("button", { name: "人工修正契约待补" })[0]).toBeDisabled();
  },
};

export const InsufficientEvidence: Story = {
  args: { data: insufficientData },
  render: args => <ProfileStory data={args.data} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("方向信号缺失")).toBeInTheDocument();
    await expect(canvas.getByText("方向维记为缺失而不是 0 分。", { exact: false })).toBeInTheDocument();
    await expect(canvas.getByText("TTC 分类链尚未统一")).toBeInTheDocument();
  },
};

export const ManualCorrectionContract: Story = {
  args: { data: manualContractData },
  render: args => <ProfileStory data={args.data} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("脱敏契约示例")).toBeInTheDocument();
    await expect(canvas.getByText(/人工从“产品”修正/)).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "修正分类" }));
    await expect(correct).toHaveBeenCalled();
  },
};

export const NarrowReview: Story = {
  render: args => <ProfileStory data={args.data} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
