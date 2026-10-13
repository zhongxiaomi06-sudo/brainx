import type { EngagementCommand, EngagementState } from "./decision-demo";
import {
  formatClock,
  actionsOf,
  directionOf,
  eligibilityOf,
  groupOf,
  RELATION_LABELS,
  mapRecommendation,
  type BackendRecommendation,
  type BrainxJob,
} from "./brainx-api.ts";
import { brainxFetch } from "./brainx-http.ts";

// 判断面板只展示用户可理解的信息：内部枚举转中文，规则版本号/来源枚举不外显（2026-09-12 文案精简）。
const decisionTierLabels: Record<string, string> = { TODAY: "今日判断", WEEK: "本周关注", VERIFY: "需先核验" };
const confidenceBandLabels: Record<string, string> = { SUFFICIENT: "数据充分", PARTIAL: "数据部分缺失", INSUFFICIENT: "数据不足" };
const agenticTierLabels: Record<string, string> = { TODAY: "今日判断", EXPLORE: "本周关注", MONITOR: "需先核验" };

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

type BackendAgenticPageItem = {
  engine: "agentic-ranking-v1"; run_id: string; decision_id: string; rank: number;
  decision_tier: "TODAY" | "EXPLORE" | "MONITOR"; reason_codes: string[];
  reason: string; tradeoff: string; evidence_refs: string[]; uncertainties: string[];
  suggested_next_action: string; generated_at: string;
  job: { project_id: string; company?: string; role?: string; city?: string | null; cities?: string[];
    pipeline?: string | null; hc?: number | null; active_state?: string | null; relation?: string | null;
    current_stage?: string | null; captured_at?: string | null };
  source_mode?: "COCKPIT_CONTEXT" | "MARKET_ONLY";
  engagement_state?: EngagementState; legal_actions?: Array<EngagementCommand | "VIEW">;
};

type AgenticPresentation = {
  rankingEngine?: "baseline-1.1" | "agentic-ranking-v1";
  agenticTradeoff?: string; agenticUncertainties?: string[];
  agenticNextAction?: string; agenticEvidenceRefs?: string[];
};

export type BackendRecommendationPage = {
  engine?: "baseline-1.1" | "agentic-ranking-v1";
  state?: "READY" | "PREVIOUS_RESULT" | "GENERATING" | "ABSTAINED" | "FAILED" | "EMPTY";
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
  items: Array<BackendRecommendationPageItem | BackendAgenticPageItem>;
};

export type RecommendationPage = {
  engine: "baseline-1.1" | "agentic-ranking-v1";
  state: string;
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
  jobs: Array<BrainxJob & AgenticPresentation>;
  engagement: Record<string, EngagementState>;
};

function mapAgenticRecommendation(item: BackendAgenticPageItem): BrainxJob & AgenticPresentation {
  const relation = item.job.relation || "UNKNOWN";
  const activeState = item.job.active_state || "UNKNOWN";
  const hc = item.job.hc ?? null;
  const action = item.decision_tier === "TODAY" ? "RECOMMEND_ACCEPT" : "OBSERVE";
  const role = String(item.job.role || "职位待确认").replace(/\*\*/g, "");
  return {
    id: item.job.project_id, rank: item.rank, company: item.job.company || "公司待确认", role,
    direction: directionOf(role), sourceMode: item.source_mode || "MARKET_ONLY",
    group: groupOf(action, hc, activeState), eligibility: eligibilityOf(action, relation, hc, activeState),
    globalScore: "—", explorationScore: "—", personalScore: "—", finalScore: "—",
    evidenceCoverage: null, recommendation: item.suggested_next_action, recentSignal: item.reason,
    facts: { "城市": item.job.city || item.job.cities?.join("、") || "UNKNOWN",
      "职位关系": RELATION_LABELS[relation] || relation, "职位状态": activeState,
      "剩余 HC": hc === null ? "UNKNOWN" : String(hc), "当前阶段": item.job.current_stage || "UNKNOWN",
      "历史 Pipeline": item.job.pipeline || "UNKNOWN", "决策层级": agenticTierLabels[item.decision_tier],
      "决策层级原因": item.reason, "事实可信度": "待核实项见 Agent 判断" },
    scoreNotes: [item.reason, item.tradeoff], risks: item.uncertainties,
    evidence: item.evidence_refs, actions: actionsOf(action, relation),
    brainxLegal: item.legal_actions?.filter((value): value is EngagementCommand => value !== "VIEW"),
    brainxDecisionId: item.decision_id, rankingEngine: "agentic-ranking-v1",
    agenticTradeoff: item.tradeoff, agenticUncertainties: item.uncertainties,
    agenticNextAction: item.suggested_next_action, agenticEvidenceRefs: item.evidence_refs,
  };
}

export function mapRecommendationPage(payload: BackendRecommendationPage): RecommendationPage {
  const engagement: Record<string, EngagementState> = {};
  const jobs = payload.items.map(item => {
    if (payload.engine === "agentic-ranking-v1") {
      const agentic = item as BackendAgenticPageItem;
      const job = mapAgenticRecommendation(agentic);
      if (agentic.engagement_state) engagement[job.id] = agentic.engagement_state;
      return job;
    }
    const baseline = item as BackendRecommendationPageItem;
    const job = mapRecommendation(baseline);
    job.facts = {
      ...job.facts,
      "决策层级": decisionTierLabels[baseline.decision_tier] || baseline.decision_tier,
      "决策层级原因": baseline.decision_tier_reason.text,
      "事实可信度": confidenceBandLabels[baseline.data_confidence.band] || baseline.data_confidence.band,
    };
    if (baseline.data_confidence.latest_fact_at) job.facts["事实更新时间"] = formatClock(baseline.data_confidence.latest_fact_at);
    if (baseline.recent_activity) {
      job.facts["最近活动"] = baseline.recent_activity.label;
      job.facts["最近活动时间"] = formatClock(baseline.recent_activity.occurred_at);
    }
    job.recentSignal = baseline.recent_activity
      ? `${baseline.recent_activity.label} · ${baseline.recent_activity.occurred_at.slice(0, 10)}`
      : baseline.decision_tier_reason.text;
    if (baseline.legal_actions) job.brainxLegal = baseline.legal_actions
      .filter((action): action is EngagementCommand => action !== "VIEW");
    if (baseline.engagement_state) engagement[job.id] = baseline.engagement_state;
    return job;
  });
  return {
    engine: payload.engine || "baseline-1.1",
    state: payload.state || "READY",
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
  signal?: AbortSignal,
): Promise<RecommendationPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  if (search.trim()) params.set("q", search.trim());
  if (sort !== "priority") params.set("sort", sort);
  const query = params.size ? `?${params.toString()}` : "";
  const payload = await brainxFetch<BackendRecommendationPage>(`/api/v1/recommendations${query}`, { signal });
  return mapRecommendationPage(payload);
}
