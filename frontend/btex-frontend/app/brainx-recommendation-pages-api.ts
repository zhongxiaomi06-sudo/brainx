import type { EngagementCommand, EngagementState } from "./decision-demo";
import {
  mapRecommendation,
  type BackendRecommendation,
  type BrainxJob,
} from "./brainx-api.ts";
import { brainxFetch } from "./brainx-http.ts";

type BackendRecommendationPageItem = BackendRecommendation & {
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
  nextCursor: string | null;
  newRunAvailable: boolean;
  jobs: BrainxJob[];
  engagement: Record<string, EngagementState>;
};

export function mapRecommendationPage(payload: BackendRecommendationPage): RecommendationPage {
  const engagement: Record<string, EngagementState> = {};
  const jobs = payload.items.map(item => {
    const job = mapRecommendation(item);
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
    nextCursor: payload.next_cursor,
    newRunAvailable: payload.new_run_available,
    jobs,
    engagement,
  };
}

export async function getRecommendationPage(cursor?: string | null): Promise<RecommendationPage> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const payload = await brainxFetch<BackendRecommendationPage>(`/api/v1/recommendations${query}`);
  return mapRecommendationPage(payload);
}
