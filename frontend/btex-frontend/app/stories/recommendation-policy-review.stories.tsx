import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  RecommendationPolicyReview,
  type RecommendationPolicyData,
} from "../recommendation-policy-review";
import { WorkspaceShell } from "../workspace-shell";

const baseData: RecommendationPolicyData = {
  policyVersion: "baseline-1.1",
  profileLabel: "Mia · 3 个画像关键词",
  initialWeights: { direction: 25, activity: 20, similarity: 15, capacity: 15, outcomes: 15, exploration: 10 },
  dimensions: [
    { key: "direction", label: "职位方向匹配", basis: "画像关键词；为空时使用历史主做项目文本", availability: "available", availabilityNote: "当前画像关键词可用。" },
    { key: "activity", label: "项目活跃度与 Pipeline", basis: "职位状态、优先级、Pipeline、更新与群活跃", availability: "available", availabilityNote: "当前快照具备活跃度输入。" },
    { key: "similarity", label: "历史项目相似度", basis: "历史 MY_JOB 的公司与职位文本", availability: "partial", availabilityNote: "仅部分历史项目已建立顾问关系。" },
    { key: "capacity", label: "当前跟进容量", basis: "关注数、跟进项目数与顾问容量上限", availability: "available", availabilityNote: "顾问当前容量数据可用。" },
    { key: "outcomes", label: "历史行为与交付结果", basis: "职位结果评分和人工标注", availability: "unavailable", availabilityNote: "当前顾问结果样本不足，不能证明调权效果。" },
    { key: "exploration", label: "探索额度", basis: "职位、顾问与日期的确定性哈希", availability: "available", availabilityNote: "每天可复现，不使用随机数。" },
  ],
  hardRules: ["同步必须完整", "职位未关闭或冷却", "project_id、客户和职位名称完整", "顾问关系不能为未知或未加入", "证据覆盖率低于 50% 只能观察"],
  preview: { contractReady: false, items: [] },
};

const previewData: RecommendationPolicyData = {
  ...baseData,
  preview: {
    contractReady: true,
    items: [
      { id: "sample-1", role: "AI 应用产品负责人", company: "脱敏客户 A", fromRank: 7, toRank: 3, reason: "方向权重提高；画像关键词与职位文本存在可核验重合。" },
      { id: "sample-2", role: "机械结构工程师", company: "脱敏客户 B", fromRank: 4, toRank: 8, reason: "探索权重降低；其余可用证据没有变化。" },
    ],
  },
};

const save = fn();
const preview = fn();

const meta = {
  title: "组合场景/推荐策略",
  component: RecommendationPolicyReview,
  parameters: { bare: true },
  args: { data: baseData, onSave: save, onRequestPreview: preview },
} satisfies Meta<typeof RecommendationPolicyReview>;

export default meta;
type Story = StoryObj<typeof meta>;

function PolicyStory({ data }: { data: RecommendationPolicyData }) {
  return <WorkspaceShell activePage="settings" onNavigate={fn()}>
    <RecommendationPolicyReview data={data} onSave={save} onRequestPreview={preview} />
  </WorkspaceShell>;
}

export const ModesAndAvailability: Story = {
  render: args => <PolicyStory data={args.data} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "推荐策略" })).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: /探索/ }));
    await expect(canvas.getByRole("button", { name: /探索/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(canvas.getByRole("button", { name: /高级自定义/ }));
    await expect(canvas.getByLabelText("历史行为与交付结果权重")).toBeDisabled();
    await expect(canvas.getByText("变化预览接口尚未接通")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "确认保存策略" })).toBeDisabled();
  },
};

function PreviewHarness() {
  const [requested, setRequested] = useState(false);
  return <WorkspaceShell activePage="settings" onNavigate={fn()}>
    <RecommendationPolicyReview data={previewData} onSave={save} onRequestPreview={() => { setRequested(true); preview(); }} />
    {requested && <span className="sr-only" role="status">预览已重新请求</span>}
  </WorkspaceShell>;
}

export const DryRunContractExample: Story = {
  render: () => <PreviewHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("脱敏契约示例")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "重新生成变化预览" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("预览已重新请求");
    await expect(canvas.getByRole("button", { name: "确认保存策略" })).toBeEnabled();
  },
};

export const NarrowReview: Story = {
  render: args => <PolicyStory data={args.data} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
