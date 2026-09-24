import type { Meta, StoryObj } from "@storybook/react";
import { OperationsDashboard } from "../operations-dashboard";
import type { OperationsDashboardModel } from "../operations-dashboard-model";

const base: OperationsDashboardModel = {
  schema_version: "operations_dashboard.v1", metric_version: "operations-dashboard-v1", health: "READY",
  freshness: { metric_version: "operations-dashboard-v1", status: "READY", checkpoint: 148,
    max_sequence: 148, backlog: 0, last_event_at: "2026-09-24T09:42:00.000Z",
    projected_at: "2026-09-24T09:42:05.000Z", lag_seconds: 5 },
  operations: { sync: { complete: 12, incomplete: 1, failed: 0 },
    jobs: { pending: 2, running: 1, succeeded: 31, failed: 2, cancelled: 0 }, delivery_failed: 1 },
  funnel: { served: 48, visible: 41, accepted: 13, interview: 7, offer: 3, onboard: 1,
    shadow_exposures: 0, shadow_outcomes: 0 },
  ranking: { live: { published: 8, failed: 1, abstained: 1, recommendation_items: 76 },
    shadow: { completed: 14, failed: 1, avg_top_10_overlap: 0.64, avg_ndcg_delta: 0.08,
      labeled_candidates: 92, hard_violations: 0 } },
  cost: { live: { calls: 24, known_calls: 22, total_tokens: 186400,
    estimated_cost_micros: 462000, failed_calls: 2, p95_latency_ms: 4200 },
  shadow: { calls: 38, known_calls: 38, total_tokens: 318000,
    estimated_cost_micros: 770000, failed_calls: 1, p95_latency_ms: 6100 } },
  capacity: { current_jobs: 137, fact_versions: 284, daily_growth: [
    { date: "2026-09-20", new_jobs: 8 }, { date: "2026-09-21", new_jobs: 4 },
    { date: "2026-09-22", new_jobs: 12 }, { date: "2026-09-23", new_jobs: 6 },
    { date: "2026-09-24", new_jobs: 9 },
  ] },
  backup: { status: "SUCCEEDED", completed_at: "2026-09-24T03:10:00.000Z",
    size_bytes: 48332800, restore_verified: true },
  sample_maturity: { exposed_decisions: 48, attributed_decisions: 11, rate: 11 / 48 },
  sources: [
    { metric: "funnel", sources: ["exposure", "decision", "business_outcome"], grain: "唯一决策 / 逻辑结果" },
    { metric: "cost", sources: ["usage"], grain: "模型调用尝试，按 LIVE/SHADOW" },
  ], caveats: ["2 次 LIVE 调用的用量未知，未按 0 填充"],
};

const meta = { title: "业务组件/管理员运营看板", component: OperationsDashboard,
  parameters: { layout: "padded" }, args: { data: base } } satisfies Meta<typeof OperationsDashboard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Normal: Story = { name: "完整事件投影" };
export const Loading: Story = { name: "加载最近快照", args: { loading: true } };
export const Backlog: Story = { name: "积压与陈旧", args: { data: { ...base,
  freshness: { ...base.freshness, status: "BACKLOG", checkpoint: 140, backlog: 8, lag_seconds: 3600 } } } };
export const Empty: Story = { name: "空数据与未上报备份", args: { data: {
  schema_version: "operations_dashboard.v1", freshness: { ...base.freshness, status: "EMPTY",
    checkpoint: 0, max_sequence: 0, backlog: 0, last_event_at: null, projected_at: null, lag_seconds: null },
  backup: { status: "NOT_REPORTED", completed_at: null, size_bytes: null, restore_verified: null },
} } };
export const Failed: Story = { name: "投影失败保留旧快照", args: { data: { ...base,
  freshness: { ...base.freshness, status: "FAILED", backlog: 6 },
  caveats: ["投影失败，当前显示最后一次成功快照"] } } };
export const Narrow: Story = { name: "窄屏", parameters: { viewport: { defaultViewport: "mobile1" } } };
