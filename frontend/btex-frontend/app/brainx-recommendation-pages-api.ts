import type { EngagementCommand, EngagementState } from "./decision-demo";
import {
  mapRecommendation,
  type BackendRecommendation,
  type BrainxJob,
} from "./brainx-api.ts";
import { brainxFetch } from "./brainx-http.ts";

export type RecommendationSort = "priority" | "activity" | "recent" | "confidence" | "exploration";

type BackendRecommendationPageItem = BackendRecommendation & {
  decision_tier: "TODAY" | "WEEK" | "VERIFY";
  decision_tier_reason: { code: string; text: string };
  data_confidence: {
    band: "SUFFICIENT" | "PARTIAL" | "INSUFFICIENT";
    rule_version: string;
    missing_fields: string[];
    latest_fact_at: string | null;
    age_days: number | null;
    stale: boolean;
    reasons: Array<{ code: string; text: string }>;
    primary_risk: string | null;
  };
  recent_activity: {
    type: string; label: string; occurred_at: string; source: string; detail: string | null;
  } | null;
  presentation_version: string;
  presentation_source: "FROZEN" | "DERIVED_LEGACY";
  engagement_state?: EngagementState;
  legal_actions?: Array<EngagementCommand | "VIEW">;
};

export type BackendRecommendationPage = {
  blocked: boolean;
  reason?: string;
  empty?: boolean;
  run_id: string | null;
  snapshot_id: string | null;
  policy_version: string | null;
  generated_at: string | null;
  evaluated_count: number;
  total_count: number;
  page_size: number;
  sort?: RecommendationSort;
  next_cursor: string | null;
  new_run_available: boolean;
  items: BackendRecommendationPageItem[];
};

export type RecommendationPage = {
  blocked: boolean;
  reason: string | null;
  runId: string | null;
  snapshotId: string | null;
  policyVersion: string | null;
  generatedAt: string | null;
  evaluatedCount: number;
  totalCount: number;
  pageSize: number;
  sort: RecommendationSort;
  nextCursor: string | null;
  newRunAvailable: boolean;
  jobs: BrainxJob[];
  engagement: Record<string, EngagementState>;
};

export function mapRecommendationPage(payload: BackendRecommendationPage): RecommendationPage {
  const engagement: Record<string, EngagementState> = {};
  const jobs = payload.items.map(item => {
    const job = mapRecommendation(item);
    job.facts = {
      ...job.facts,
      "决策层级": item.decision_tier,
      "决策层级原因": item.decision_tier_reason.text,
      "事实可信度": item.data_confidence.band,
      "事实可信度规则": item.data_confidence.rule_version,
      "事实更新时间": item.data_confidence.latest_fact_at || "UNKNOWN",
      "最近活动": item.recent_activity?.label || "UNKNOWN",
      "最近活动时间": item.recent_activity?.occurred_at || "UNKNOWN",
      "最近活动来源": item.recent_activity?.source || "UNKNOWN",
    };
    job.recentSignal = item.recent_activity
      ? `${item.recent_activity.label} · ${item.recent_activity.occurred_at.slice(0, 10)}`
      : item.decision_tier_reason.text;
    if (item.legal_actions) job.brainxLegal = item.legal_actions
      .filter((action): action is EngagementCommand => action !== "VIEW");
    if (item.engagement_state) engagement[job.id] = item.engagement_state;
    return job;
  });
  return {
    blocked: payload.blocked,
    reason: payload.reason || null,
    runId: payload.run_id,
    snapshotId: payload.snapshot_id,
    policyVersion: payload.policy_version,
    generatedAt: payload.generated_at,
    evaluatedCount: payload.evaluated_count,
    totalCount: payload.total_count,
    pageSize: payload.page_size,
    sort: payload.sort || "priority",
    nextCursor: payload.next_cursor,
    newRunAvailable: payload.new_run_available,
    jobs,
    engagement,
  };
}

export async function getRecommendationPage(
  cursor?: string | null,
  search = "",
  sort: RecommendationSort = "priority",
): Promise<RecommendationPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (search.trim()) params.set("q", search.trim());
  if (sort !== "priority") params.set("sort", sort);
  const query = params.size ? `?${params.toString()}` : "";
  const payload = await brainxFetch<BackendRecommendationPage>(`/api/v1/recommendations${query}`);
  return mapRecommendationPage(payload);
}
